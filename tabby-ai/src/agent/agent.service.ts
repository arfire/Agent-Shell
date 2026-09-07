import { Injectable } from '@angular/core'
import * as crypto from 'crypto'

import { AIConfigService } from '../config/ai-config.service'
import { ChatCompletionsClient, ChatTool, ToolCall } from '../llm/chat-completions.client'
import { CommandPolicyDecision, CommandPolicyService } from '../policy/command-policy.service'
import { SecretRedactor, SecretRedactionScope } from '../policy/secret-redactor'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { AIInputMiddleware } from '../terminal/ai-input.middleware'
import { TerminalControllerService } from '../terminal/terminal-controller.service'
import { InteractivePromptKind } from '../terminal/command-framing.middleware'
import { AgentTerminalPresenter } from '../terminal/agent-terminal-presenter'
import { AgentContextBuilder } from './context-builder'
import { AgentInteractionService } from './interaction.service'
import { AgentRunQueue } from './run-queue'
import { AgentPermissionsService, approvalAction, CommandAuthorization } from '../policy/agent-permissions.service'

const TERMINAL_TOOLS: ChatTool[] = [{
    type: 'function',
    'function': {
        name: 'terminal_exec',
        description: 'Execute one command step using the current SSH shell syntax and return its output and exit code.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'A command for the current shell. Format long combined commands over multiple lines with readable indentation and shell-safe continuations.' },
                reason: { type: 'string', description: 'A concise user-facing reason for running this command.' },
            },
            required: ['command', 'reason'],
            additionalProperties: false,
        },
    },
}, {
    type: 'function',
    'function': {
        name: 'request_user_input',
        description: 'Show a local interactive form when required information is missing. Secret values are never sent back to the model; the result contains an opaque placeholder for use in terminal_exec.',
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'A concise question shown to the user.' },
                kind: { type: 'string', 'enum': ['text', 'secret'], description: 'Use secret for credentials, tokens, private endpoints and other sensitive values.' },
            },
            required: ['prompt', 'kind'],
            additionalProperties: false,
        },
    },
}]

interface ActiveRun {
    id: string
    controller: AbortController
    stopRequested: boolean
    goal: string
    sensitive: SecretRedactionScope
    session: AISessionRuntime['tab']['session']
}

class UserRejectedError extends Error { }

function isHigherRisk (next: CommandPolicyDecision, previous: CommandPolicyDecision): boolean {
    const weight = { SAFE: 0, MODIFY: 1, DANGEROUS: 2, DENY: 3 }
    return weight[next.risk] > weight[previous.risk]
}

function getErrorMessage (error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

@Injectable({ providedIn: 'root' })
export class AgentService {
    private activeRuns = new Map<string, ActiveRun>()

    constructor (
        private config: AIConfigService,
        private client: ChatCompletionsClient,
        private context: AgentContextBuilder,
        private policy: CommandPolicyService,
        private redactor: SecretRedactor,
        private sessions: AISessionService,
        private interactions: AgentInteractionService,
        private queue: AgentRunQueue,
        private terminal: TerminalControllerService,
        private presenter: AgentTerminalPresenter,
        private permissions: AgentPermissionsService,
    ) { }

    async start (runtime: AISessionRuntime, input: string, inputMiddleware: AIInputMiddleware): Promise<void> {
        if (!!runtime.activeRunId || runtime.state.value === 'LOADING_CONTEXT') {
            return
        }
        const run: ActiveRun = {
            id: crypto.randomUUID(),
            controller: new AbortController(),
            stopRequested: false,
            goal: input,
            sensitive: this.redactor.createScope(),
            session: runtime.tab.session,
        }
        let complete = (): void => { /* Set by the Promise executor below. */ }
        const completed = new Promise<void>(resolve => { complete = resolve })
        const protectedInput = run.sensitive.protect(input)
        runtime.activeRunId = run.id
        runtime.stopAgent = () => this.stop(runtime)
        runtime.handoffAgent = async () => {
            run.stopRequested = true
            // Drain any final model batch while the prompt is still ours. Command
            // execution already interrupts the presenter before sending its wrapper.
            await this.presenter.interrupt(run.id)
            this.terminal.releaseControl(runtime)
            this.interactions.cancelRun(run.id)
            if (!this.terminal.isExecuting(runtime)) {
                run.controller.abort(new DOMException('Terminal handed to user', 'AbortError'))
                await completed
            }
        }
        runtime.locked = true
        runtime.state.next('QUEUED')
        this.activeRuns.set(runtime.id, run)

        let release: (() => void)|null = null
        try {
            await this.sessions.append(runtime, 'user-ai-input', { content: protectedInput }, run.id)
            await this.sessions.append(runtime, 'agent-state', { state: 'QUEUED' }, run.id)
            await this.presenter.open(runtime, run.id, () => this.stop(runtime))
            await this.config.ready
            release = await this.queue.acquire(run.controller.signal)
            runtime.state.next('THINKING')
            await this.sessions.append(runtime, 'agent-state', { state: 'THINKING' }, run.id)
            await this.runLoop(runtime, run, protectedInput)
            if (run.stopRequested) {
                throw new DOMException('Agent stopped', 'AbortError')
            }
            runtime.state.next('DONE')
            await this.sessions.append(runtime, 'agent-state', { state: 'DONE' }, run.id)
        } catch (error) {
            await this.preserveLiveText(runtime, run)
            const cancelled = run.stopRequested || error instanceof UserRejectedError || error instanceof DOMException && error.name === 'AbortError'
            const state = cancelled ? 'CANCELLED' : 'FAILED'
            runtime.state.next(state)
            await this.sessions.append(runtime, cancelled ? 'agent-state' : 'error', cancelled
                ? { state, reason: getErrorMessage(error) }
                : { message: getErrorMessage(error) }, run.id)
        } finally {
            try {
                await this.presenter.finish(run.id)
                if (runtime.tab.session === run.session) {
                    await this.terminal.restorePrompt(runtime)
                }
            } catch (error) {
                runtime.terminal.next({ ...runtime.terminal.value, notice: `提示符恢复失败：${getErrorMessage(error)}` })
            }
            release?.()
            this.interactions.cancelRun(run.id)
            this.activeRuns.delete(runtime.id)
            runtime.activeRunId = undefined
            runtime.stopAgent = undefined
            runtime.handoffAgent = undefined
            runtime.liveText.next('')
            // Reset the shadow readline state and enqueue the fresh prompt
            // before accepting another xterm/IME commit. Otherwise a very
            // quick next input can race the previous run's cleanup.
            inputMiddleware.resetInputBuffer()
            runtime.locked = false
            runtime.terminal.next({ ...runtime.terminal.value, ready: inputMiddleware.canCapture })
            runtime.tab.frontend?.focus()
            complete()
        }
    }

    stop (runtime: AISessionRuntime): void {
        const run = this.activeRuns.get(runtime.id)
        if (!run) {
            return
        }
        run.stopRequested = true
        this.interactions.cancelRun(run.id)
        run.controller.abort(new DOMException('Agent stopped', 'AbortError'))
    }

    private async runLoop (runtime: AISessionRuntime, run: ActiveRun, input: string): Promise<void> {
        const messages = this.context.build(
            runtime,
            input,
            this.config.config.agent.maxContextTokens,
            content => run.sensitive.protect(content),
        )
        for (let step = 0; step < 50; step++) {
            if (run.stopRequested) {
                throw new DOMException('Agent stopped', 'AbortError')
            }
            runtime.state.next('THINKING')
            runtime.liveText.next('')
            const textFilter = run.sensitive.streamFilter()
            const result = await this.client.stream(messages, TERMINAL_TOOLS, {
                onText: text => runtime.liveText.next(runtime.liveText.value + textFilter(text)),
            }, run.controller.signal)
            runtime.liveText.next(runtime.liveText.value + textFilter.flush())
            if (result.content) {
                await this.sessions.append(runtime, 'ai-message', { content: result.content }, run.id)
            }
            runtime.liveText.next('')
            messages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            })
            if (!result.toolCalls.length) {
                return
            }
            for (const toolCall of result.toolCalls) {
                const toolResult = await this.executeTool(runtime, run, toolCall)
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: run.sensitive.redactKnown(toolResult),
                })
            }
        }
        throw new Error('Agent exceeded the maximum of 50 command steps')
    }

    private async executeTool (runtime: AISessionRuntime, run: ActiveRun, toolCall: ToolCall): Promise<string> {
        if (toolCall.function.name === 'request_user_input') {
            return this.requestUserInput(runtime, run, toolCall)
        }
        if (toolCall.function.name !== 'terminal_exec') {
            return JSON.stringify({ error: `Unsupported tool: ${toolCall.function.name}` })
        }
        let argumentsValue: { command?: unknown, reason?: unknown } = {}
        try {
            argumentsValue = JSON.parse(toolCall.function.arguments)
        } catch (error) {
            return JSON.stringify({ error: `Invalid tool arguments: ${String(error)}` })
        }
        if (typeof argumentsValue.command !== 'string' || typeof argumentsValue.reason !== 'string') {
            return JSON.stringify({ error: 'terminal_exec requires string command and reason fields' })
        }
        let command = run.sensitive.protect(argumentsValue.command.trim())
        if (!command) { return JSON.stringify({ error: 'Command must not be empty' }) }
        const reason = run.sensitive.protect(argumentsValue.reason.trim())
        const authorization = this.permissions.snapshot(runtime)
        let decision = this.policy.evaluate(command, runtime.shellKind, authorization.policy)
        await this.sessions.append(runtime, 'ai-command', { command, reason, risk: decision.risk, permissionMode: authorization.mode }, run.id)

        const action = approvalAction(decision.risk, authorization.mode)
        if (action === 'deny') {
            return JSON.stringify({ error: 'Command denied by local policy', reason: decision.reason })
        }
        if (action === 'ask') {
            runtime.state.next('WAITING_APPROVAL')
            const response = await this.interactions.request({
                sessionId: runtime.id,
                runId: run.id,
                command,
                reason: `${reason}\nPolicy: ${decision.reason}`,
                risk: decision.risk,
                confirmationsRequired: decision.risk === 'DANGEROUS' ? 2 : 1,
            })
            const protectedEditedCommand = run.sensitive.protect(response.command.trim())
            await this.sessions.append(runtime, 'approval', {
                approved: response.approved,
                originalCommand: command,
                finalCommand: protectedEditedCommand,
                permissionMode: authorization.mode,
            }, run.id)
            if (!response.approved) {
                throw new UserRejectedError('User rejected the command')
            }
            const originalDecision = decision
            command = protectedEditedCommand
            if (!command) { return JSON.stringify({ error: 'Command must not be empty' }) }
            decision = this.policy.evaluate(command, runtime.shellKind, authorization.policy)
            if (isHigherRisk(decision, originalDecision)) {
                return this.executeReclassifiedCommand(runtime, run, command, reason, decision, authorization)
            }
        } else {
            await this.sessions.append(runtime, 'approval', {
                approved: true, automatic: true, finalCommand: command,
                permissionMode: authorization.mode, risk: decision.risk,
            }, run.id)
        }

        return this.executeApprovedCommand(runtime, run, command, reason, decision, authorization)
    }

    private async executeReclassifiedCommand (
        runtime: AISessionRuntime,
        run: ActiveRun,
        command: string,
        reason: string,
        decision: CommandPolicyDecision,
        authorization: CommandAuthorization,
    ): Promise<string> {
        if (decision.risk === 'DENY') {
            return JSON.stringify({ error: 'Edited command denied by local policy', reason: decision.reason })
        }
        const response = await this.interactions.request({
            sessionId: runtime.id,
            runId: run.id,
            command,
            reason: `Edited command was reclassified: ${decision.reason}`,
            risk: decision.risk,
            confirmationsRequired: decision.risk === 'DANGEROUS' ? 2 : 1,
        })
        const protectedEditedCommand = run.sensitive.protect(response.command.trim())
        await this.sessions.append(runtime, 'approval', {
            approved: response.approved,
            originalCommand: command,
            finalCommand: protectedEditedCommand,
            reclassified: true,
            permissionMode: authorization.mode,
            risk: decision.risk,
        }, run.id)
        if (!response.approved) {
            throw new UserRejectedError('User rejected the reclassified command')
        }
        if (!protectedEditedCommand) { return JSON.stringify({ error: 'Command must not be empty' }) }
        const finalDecision = this.policy.evaluate(protectedEditedCommand, runtime.shellKind, authorization.policy)
        if (isHigherRisk(finalDecision, decision)) {
            return this.executeReclassifiedCommand(runtime, run, protectedEditedCommand, reason, finalDecision, authorization)
        }
        return this.executeApprovedCommand(runtime, run, protectedEditedCommand, reason, finalDecision, authorization)
    }

    private async executeApprovedCommand (
        runtime: AISessionRuntime,
        run: ActiveRun,
        command: string,
        reason: string,
        decision: CommandPolicyDecision,
        authorization: CommandAuthorization,
    ): Promise<string> {
        if (this.isStopped(run)) {
            throw new DOMException('Agent stopped before command execution', 'AbortError')
        }
        if (approvalAction(decision.risk, authorization.mode) === 'deny') {
            return JSON.stringify({ error: 'Command denied by local policy', reason: decision.reason })
        }
        runtime.state.next('EXECUTING')
        await this.sessions.append(runtime, 'ssh-input', { content: command, source: 'ai', reason }, run.id)
        await this.presenter.interrupt(run.id)
        try {
            const executableCommand = run.sensitive.restore(command)
            const result = await this.terminal.execute(runtime, executableCommand, (prompt, kind) =>
                this.handleInteractivePrompt(runtime, run, prompt, kind), run.controller.signal,
            run.sensitive.streamFilter())
            await this.sessions.append(runtime, 'command-result', { exitCode: result.exitCode, handedOff: run.stopRequested }, run.id)
            runtime.state.next('OBSERVING')
            if (run.stopRequested) {
                throw new DOMException('Agent stopped after command completion', 'AbortError')
            }
            return JSON.stringify({ exitCode: result.exitCode, output: result.output })
        } finally {
            if (!run.stopRequested && !run.controller.signal.aborted) {
                await this.presenter.open(runtime, run.id, () => this.stop(runtime), this.nextEventSeq(runtime))
            }
        }
    }

    private async requestUserInput (runtime: AISessionRuntime, run: ActiveRun, toolCall: ToolCall): Promise<string> {
        let argumentsValue: { prompt?: unknown, kind?: unknown } = {}
        try {
            argumentsValue = JSON.parse(toolCall.function.arguments)
        } catch (error) {
            return JSON.stringify({ error: `Invalid tool arguments: ${String(error)}` })
        }
        if (typeof argumentsValue.prompt !== 'string' || !['text', 'secret'].includes(String(argumentsValue.kind))) {
            return JSON.stringify({ error: 'request_user_input requires a prompt and kind of text or secret' })
        }
        runtime.state.next('WAITING_INTERACTION')
        const form = await this.interactions.requestForm({
            sessionId: runtime.id,
            runId: run.id,
            prompt: argumentsValue.prompt,
            kind: argumentsValue.kind === 'secret' ? 'password' : 'text',
        })
        runtime.state.next('THINKING')
        if (!form.submitted) {
            throw new UserRejectedError('User cancelled the requested input')
        }
        if (argumentsValue.kind === 'secret') {
            const placeholder = run.sensitive.register(form.value)
            await this.sessions.append(runtime, 'interaction', {
                prompt: argumentsValue.prompt,
                kind: 'secret',
                response: '[SENSITIVE_VALUE_PROVIDED_LOCALLY]',
            }, run.id)
            return JSON.stringify({ value: placeholder, sensitive: true })
        }
        const value = run.sensitive.protect(form.value)
        await this.sessions.append(runtime, 'interaction', {
            prompt: argumentsValue.prompt,
            kind: 'text',
            response: value,
        }, run.id)
        return JSON.stringify({ value, sensitive: value !== form.value })
    }

    private async handleInteractivePrompt (
        runtime: AISessionRuntime,
        run: ActiveRun,
        prompt: string,
        kind: InteractivePromptKind,
    ): Promise<string|null> {
        runtime.state.next('WAITING_INTERACTION')
        let value: string|null = null
        if (kind === 'yes-no') {
            const response = await this.client.stream([
                {
                    role: 'system',
                    content: 'Choose the response to the interactive Linux command prompt from the user goal. Reply with exactly y or n and nothing else.',
                },
                {
                    role: 'user',
                    content: run.sensitive.protect(`Goal: ${run.goal}\nPrompt: ${prompt}`),
                },
            ], [], {}, run.controller.signal)
            const answer = response.content.trim().toLowerCase()
            if (answer === 'y' || answer === 'yes') {
                value = 'y'
            } else if (answer === 'n' || answer === 'no') {
                value = 'n'
            }
        }
        if (value === null) {
            await this.presenter.open(runtime, run.id, () => this.stop(runtime), this.nextEventSeq(runtime))
            try {
                const form = await this.interactions.requestForm({
                    sessionId: runtime.id,
                    runId: run.id,
                    prompt,
                    kind: kind === 'password' ? 'password' : 'text',
                })
                if (form.submitted) {
                    value = form.value
                    if (kind === 'password') {
                        run.sensitive.register(value)
                    }
                }
            } finally {
                await this.presenter.interrupt(run.id)
            }
        }
        if (value !== null) {
            await this.sessions.append(runtime, 'interaction', {
                prompt: run.sensitive.protect(prompt),
                kind,
                response: kind === 'password' ? '[PASSWORD_PROVIDED]' : value,
            }, run.id)
        }
        runtime.state.next('EXECUTING')
        return value
    }

    private nextEventSeq (runtime: AISessionRuntime): number {
        const events = runtime.events.value
        return events.length ? events[events.length - 1].seq + 1 : 0
    }

    private isStopped (run: ActiveRun): boolean {
        return run.stopRequested || run.controller.signal.aborted
    }

    private async preserveLiveText (runtime: AISessionRuntime, run: ActiveRun): Promise<void> {
        const content = runtime.liveText.value
        if (!content) {
            return
        }
        await this.sessions.append(runtime, 'ai-message', { content, partial: true }, run.id)
        runtime.liveText.next('')
    }
}
