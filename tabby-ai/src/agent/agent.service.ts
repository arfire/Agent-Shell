import { Injectable } from '@angular/core'
import * as crypto from 'crypto'

import { AIConfigService } from '../config/ai-config.service'
import { ChatCompletionsClient, ChatTool, ToolCall } from '../llm/chat-completions.client'
import { CommandPolicyDecision, CommandPolicyService } from '../policy/command-policy.service'
import { SecretRedactor } from '../policy/secret-redactor'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { AIInputMiddleware } from '../terminal/ai-input.middleware'
import { TerminalControllerService } from '../terminal/terminal-controller.service'
import { InteractivePromptKind } from '../terminal/command-framing.middleware'
import { InlineBlockService } from '../ui/inline-block.service'
import { AgentContextBuilder } from './context-builder'
import { AgentInteractionService } from './interaction.service'
import { AgentRunQueue } from './run-queue'

const TERMINAL_TOOLS: ChatTool[] = [{
    type: 'function',
    function: {
        name: 'terminal_exec',
        description: 'Execute one Linux shell command step in the current SSH session and return its output and exit code.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'A Linux shell command. Combined shell syntax is allowed.' },
                reason: { type: 'string', description: 'A concise user-facing reason for running this command.' },
            },
            required: ['command', 'reason'],
            additionalProperties: false,
        },
    },
}]

interface ActiveRun {
    id: string
    controller: AbortController
    stopRequested: boolean
    goal: string
}

class UserRejectedError extends Error { }

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
        private blocks: InlineBlockService,
    ) { }

    async start (runtime: AISessionRuntime, input: string, _inputMiddleware: AIInputMiddleware): Promise<void> {
        if (runtime.activeRunId) {
            return
        }
        const run: ActiveRun = {
            id: crypto.randomUUID(),
            controller: new AbortController(),
            stopRequested: false,
            goal: input,
        }
        runtime.activeRunId = run.id
        runtime.locked = true
        runtime.state.next('QUEUED')
        this.activeRuns.set(runtime.id, run)

        let release: (() => void)|null = null
        try {
            await this.sessions.append(runtime, 'user-ai-input', { content: input }, run.id)
            await this.sessions.append(runtime, 'agent-state', { state: 'QUEUED' }, run.id)
            await this.blocks.open(runtime, run.id, () => this.stop(runtime))
            await this.config.ready
            release = await this.queue.acquire(run.controller.signal)
            runtime.state.next('THINKING')
            await this.sessions.append(runtime, 'agent-state', { state: 'THINKING' }, run.id)
            await this.runLoop(runtime, run, input)
            if (run.stopRequested) {
                throw new DOMException('Agent stopped', 'AbortError')
            }
            runtime.state.next('DONE')
            await this.sessions.append(runtime, 'agent-state', { state: 'DONE' }, run.id)
        } catch (error) {
            const cancelled = run.stopRequested || error instanceof UserRejectedError || (error as any)?.name === 'AbortError'
            const state = cancelled ? 'CANCELLED' : 'FAILED'
            runtime.state.next(state)
            await this.sessions.append(runtime, cancelled ? 'agent-state' : 'error', cancelled
                ? { state, reason: String((error as Error)?.message ?? error) }
                : { message: String((error as Error)?.message ?? error) }, run.id)
        } finally {
            release?.()
            this.interactions.cancelRun(run.id)
            this.activeRuns.delete(runtime.id)
            runtime.activeRunId = undefined
            runtime.liveText.next('')
            runtime.locked = false
        }
    }

    stop (runtime: AISessionRuntime): void {
        const run = this.activeRuns.get(runtime.id)
        if (!run) {
            return
        }
        run.stopRequested = true
        this.interactions.cancelRun(run.id)
        if (runtime.state.value !== 'EXECUTING' && runtime.state.value !== 'OBSERVING') {
            run.controller.abort(new DOMException('Agent stopped', 'AbortError'))
        }
    }

    private async runLoop (runtime: AISessionRuntime, run: ActiveRun, input: string): Promise<void> {
        const messages = this.context.build(runtime, input, this.config.config.agent.maxContextTokens)
        for (let step = 0; step < 50; step++) {
            if (run.stopRequested) {
                throw new DOMException('Agent stopped', 'AbortError')
            }
            runtime.state.next('THINKING')
            runtime.liveText.next('')
            const result = await this.client.stream(messages, TERMINAL_TOOLS, {
                onText: text => runtime.liveText.next(runtime.liveText.value + text),
            }, run.controller.signal)
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
                    content: this.redactor.redact(toolResult),
                })
            }
        }
        throw new Error('Agent exceeded the maximum of 50 command steps')
    }

    private async executeTool (runtime: AISessionRuntime, run: ActiveRun, toolCall: ToolCall): Promise<string> {
        if (toolCall.function.name !== 'terminal_exec') {
            return JSON.stringify({ error: `Unsupported tool: ${toolCall.function.name}` })
        }
        let argumentsValue: { command?: unknown, reason?: unknown }
        try {
            argumentsValue = JSON.parse(toolCall.function.arguments)
        } catch (error) {
            return JSON.stringify({ error: `Invalid tool arguments: ${String(error)}` })
        }
        if (typeof argumentsValue.command !== 'string' || typeof argumentsValue.reason !== 'string') {
            return JSON.stringify({ error: 'terminal_exec requires string command and reason fields' })
        }
        let command = argumentsValue.command.trim()
        const reason = argumentsValue.reason.trim()
        let decision = this.policy.evaluate(command)
        await this.sessions.append(runtime, 'ai-command', { command, reason, risk: decision.risk }, run.id)

        if (decision.risk === 'DENY') {
            return JSON.stringify({ error: 'Command denied by local policy', reason: decision.reason })
        }
        if (decision.risk !== 'SAFE') {
            runtime.state.next('WAITING_APPROVAL')
            const response = await this.interactions.request({
                sessionId: runtime.id,
                runId: run.id,
                command,
                reason,
                risk: decision.risk,
                confirmationsRequired: decision.risk === 'DANGEROUS' ? 2 : 1,
            })
            await this.sessions.append(runtime, 'approval', {
                approved: response.approved,
                originalCommand: command,
                finalCommand: response.command,
            }, run.id)
            if (!response.approved) {
                throw new UserRejectedError('User rejected the command')
            }
            const originalDecision = decision
            command = response.command.trim()
            decision = this.policy.evaluate(command)
            if (isHigherRisk(decision, originalDecision)) {
                return await this.executeReclassifiedCommand(runtime, run, command, reason, decision)
            }
        }

        return await this.executeApprovedCommand(runtime, run, command, reason, decision)
    }

    private async executeReclassifiedCommand (
        runtime: AISessionRuntime,
        run: ActiveRun,
        command: string,
        reason: string,
        decision: CommandPolicyDecision,
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
        await this.sessions.append(runtime, 'approval', {
            approved: response.approved,
            originalCommand: command,
            finalCommand: response.command,
            reclassified: true,
            risk: decision.risk,
        }, run.id)
        if (!response.approved) {
            throw new UserRejectedError('User rejected the reclassified command')
        }
        const finalDecision = this.policy.evaluate(response.command)
        if (isHigherRisk(finalDecision, decision)) {
            return await this.executeReclassifiedCommand(runtime, run, response.command, reason, finalDecision)
        }
        return this.executeApprovedCommand(runtime, run, response.command, reason, finalDecision)
    }

    private async executeApprovedCommand (
        runtime: AISessionRuntime,
        run: ActiveRun,
        command: string,
        reason: string,
        decision: CommandPolicyDecision,
    ): Promise<string> {
        if (decision.risk === 'DENY') {
            return JSON.stringify({ error: 'Command denied by local policy', reason: decision.reason })
        }
        runtime.state.next('EXECUTING')
        await this.sessions.append(runtime, 'ssh-input', { content: command, source: 'ai', reason }, run.id)
        const result = await this.terminal.execute(runtime, command, (prompt, kind) =>
            this.handleInteractivePrompt(runtime, run, prompt, kind))
        runtime.state.next('OBSERVING')
        if (run.stopRequested) {
            throw new DOMException('Agent stopped after command completion', 'AbortError')
        }
        return JSON.stringify({ exitCode: result.exitCode, output: result.output })
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
                    content: this.redactor.redact(`Goal: ${run.goal}\nPrompt: ${prompt}`),
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
            const form = await this.interactions.requestForm({
                sessionId: runtime.id,
                runId: run.id,
                prompt,
                kind: kind === 'password' ? 'password' : 'text',
            })
            if (form.submitted) {
                value = form.value
            }
        }
        if (value !== null) {
            await this.sessions.append(runtime, 'interaction', {
                prompt,
                kind,
                response: kind === 'password' ? '[PASSWORD_PROVIDED]' : value,
            }, run.id)
        }
        runtime.state.next('EXECUTING')
        return value
    }
}

function isHigherRisk (next: CommandPolicyDecision, previous: CommandPolicyDecision): boolean {
    const weight = { SAFE: 0, MODIFY: 1, DANGEROUS: 2, DENY: 3 }
    return weight[next.risk] > weight[previous.risk]
}
