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
import { AgentPermissionsService, approvalAction, CommandAuthorization, permissionInstructions } from '../policy/agent-permissions.service'
import { credentialAccessReason, opaqueConfigurationCommand } from '../policy/credential-guard'
import { taskCommandReason, taskRestrictions } from '../policy/task-boundary'
import { validateSecretBinding } from '../policy/secret-binding'
import { CONFIGURATION_TOOL, configurationCommand, configurationRoots, configurationSummary, projectPaths, validConfigurationKeys } from './configuration-inspection'
import { commandRiskDescription } from '../policy/command-description'
import { WebService, WebRunState } from '../web/web.service'

const TERMINAL_TOOLS: ChatTool[] = [{
    type: 'function',
    'function': {
        name: 'terminal_exec',
        description: 'Execute a noninteractive command in a fresh process on the current SSH connection (no PTY, stdin closed). Output activity renews a 10-minute idle timeout; active downloads have no fixed total limit. Return output and exit code. Use absolute paths; cd/export do not persist between calls. Never start pagers or interactive editors.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'A command for the current shell. Format long combined commands over multiple lines with readable indentation and shell-safe continuations.' },
                reason: { type: 'string', description: 'Briefly explain the command effect in the user language. Mention concrete risks such as deletion, overwrite, interruption or permission changes. Do not add unrelated actions.' },
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
                kind: { type: 'string', 'enum': ['text', 'secret'], description: 'Use secret for credentials and tokens. In restricted modes program and target are required and enforced locally; unrestricted mode has no destination binding.' },
                program: { type: 'string', description: 'For secret: curl, wget, mysql, mariadb, mysqldump, psql, pg_dump or sudo.' },
                target: { type: 'string', description: 'For secret: HTTP(S) service origin, database host (localhost if local), or current-server for sudo. Shown to the user before accepting the secret.' },
            },
            required: ['prompt', 'kind'],
            additionalProperties: false,
        },
    },
}, {
    type: 'function',
    'function': {
        name: 'generate_secret',
        description: 'In unrestricted mode, generate a random password without saving it to the vault. Use it for the task and tell the user the password and how to change it when finished. In other modes use request_user_input(kind="secret").',
        parameters: {
            type: 'object', properties: { description: { type: 'string', description: 'Short credential name, including the service it belongs to.' } },
            required: ['description'], additionalProperties: false,
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
    web?: WebRunState
    containsSensitiveContext?: boolean
    operationFailed?: boolean
    executingAuthorization?: CommandAuthorization
    interruptedExecution?: boolean
    projectPaths?: string[]
}

class UserRejectedError extends Error { }
class CommandBlockedError extends Error {
    constructor (message: string, public readonly command: string) { super(message) }
}

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
        private web?: WebService,
    ) { }

    async start (runtime: AISessionRuntime, input: string, inputMiddleware?: AIInputMiddleware): Promise<void> {
        if (!!runtime.activeRunId || runtime.state.value === 'LOADING_CONTEXT') {
            return
        }
        const run: ActiveRun = {
            id: crypto.randomUUID(),
            controller: new AbortController(),
            stopRequested: false,
            goal: input,
            sensitive: this.redactor.createScope(() => {
                const unrestricted = this.permissions.mode(runtime) === 'unrestricted'
                if (unrestricted) { run.containsSensitiveContext = true }
                return unrestricted
            }),
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
            if (error instanceof UserRejectedError && !run.stopRequested) {
                await this.sessions.append(runtime, 'error', { message: getErrorMessage(error), source: 'local-stop' }, run.id)
            }
            await this.sessions.append(runtime, cancelled ? 'agent-state' : 'error', cancelled
                ? { state, reason: getErrorMessage(error), message: run.stopRequested
                    ? run.interruptedExecution ? '已手动停止 Agent，终端可以继续操作。上方保留最后进度；执行通道已关闭，远端任务是否结束仍需核实。'
                        : '已手动停止 Agent，终端可以继续操作。' : undefined }
                : { message: getErrorMessage(error) }, run.id)
        } finally {
            try {
                await this.presenter.finish(run.id)
                if (runtime.tab.session === run.session && !this.presenter.hasDeferred(runtime.id)) {
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
            run.sensitive.clear()
            // Reset the shadow readline state and enqueue the fresh prompt
            // before accepting another xterm/IME commit. Otherwise a very
            // quick next input can race the previous run's cleanup.
            if (!run.stopRequested) { inputMiddleware?.resetInputBuffer() }
            runtime.locked = false
            runtime.terminal.next({ ...runtime.terminal.value, ready: inputMiddleware?.canCapture ?? runtime.terminal.value.ready })
            // Return to the native input unless the user is reviewing model context.
            if (inputMiddleware && !runtime.tab.content?.nativeElement.ownerDocument.activeElement?.closest('.context-panel')) {
                runtime.tab.frontend?.focus()
            }
            complete()
        }
    }

    stop (runtime: AISessionRuntime): void {
        const run = this.activeRuns.get(runtime.id)
        if (!run) {
            return
        }
        run.stopRequested = true
        run.interruptedExecution = this.terminal.isExecuting(runtime)
        runtime.locked = false
        this.interactions.cancelRun(run.id)
        run.controller.abort(new DOMException('Agent stopped', 'AbortError'))
    }

    private async runLoop (runtime: AISessionRuntime, run: ActiveRun, input: string): Promise<void> {
        const webTools = this.web?.tools(input) ?? []
        run.web = { input, calls: 0, remainingChars: Math.min(32000, this.config.config.agent.maxContextTokens),
            onRequest: (body, model) => this.recordRequest(runtime, run, body, model, '联网模型'),
        }
        let messages = this.context.build(
            runtime,
            input,
            Math.floor(this.config.config.agent.maxContextTokens * (webTools.length ? 0.75 : 1)),
            content => run.sensitive.protect(content),
            this.permissions.mode(runtime) === 'unrestricted',
        )
        for (let step = 0; step < 50; step++) {
            if (run.stopRequested) {
                throw new DOMException('Agent stopped', 'AbortError')
            }
            const mode = this.permissions.mode(runtime)
            if (run.containsSensitiveContext && mode !== 'unrestricted') {
                messages = this.context.build(runtime, this.redactor.redact(input), this.config.config.agent.maxContextTokens)
                run.containsSensitiveContext = false
            }
            const permissionMessage = { role: 'system' as const, content: permissionInstructions(mode) }
            runtime.state.next('THINKING')
            runtime.liveText.next('')
            const textFilter = run.sensitive.streamFilter()
            const restrictions = mode === 'unrestricted' ? undefined : taskRestrictions(run.goal)
            const tools = restrictions?.tools === false ? [] : [
                ...TERMINAL_TOOLS.filter(tool => (mode === 'unrestricted' || tool.function.name !== 'generate_secret') &&
                    (restrictions?.commands !== false || tool.function.name !== 'terminal_exec')),
                ...restrictions?.commands !== false ? [CONFIGURATION_TOOL] : [],
                ...this.web?.tools(input) ?? [],
            ]
            const result = await this.client.stream([permissionMessage, ...messages], tools, {
                onRequest: (body, model) => this.recordRequest(runtime, run, body, model, 'Agent'),
                onText: text => runtime.liveText.next(runtime.liveText.value + textFilter(text)),
            }, run.controller.signal)
            runtime.liveText.next(runtime.liveText.value + textFilter.flush())
            if (result.content) {
                await this.sessions.append(runtime, 'ai-message', { content: result.content,
                    localOnly: !!run.containsSensitiveContext || mode === 'unrestricted' }, run.id)
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
            let blocked = false
            for (const toolCall of result.toolCalls) {
                let toolResult = JSON.stringify({ executed: false, error: '上一项命令未执行，请根据其反馈重新决定后续步骤。' })
                if (!blocked) {
                    try { toolResult = await this.executeTool(runtime, run, toolCall) } catch (error) {
                        if (!(error instanceof CommandBlockedError)) { throw error }
                        blocked = true
                        const reason = run.sensitive.protect(error.message)
                        const command = run.sensitive.protect(error.command)
                        toolResult = JSON.stringify({ executed: false, command, error: reason,
                            next: '记住这次反馈，按当前权限继续原任务。写法不支持时可提交可检查的等效命令；缺少密码时调用 request_user_input(kind="secret")，复用本任务已提供的占位符。禁止的操作不得换工具绕过。需要用户选择时简述可行方案、差异和推荐项，通过现有表单询问。' })
                        await this.sessions.append(runtime, 'error', { command, message: '本条命令未执行，已将原因反馈给模型：' + reason, source: 'policy-feedback' }, run.id)
                    }
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    // WebService already redacts each value before serializing its JSON.
                    content: ['web_search', 'web_fetch'].includes(toolCall.function.name) ? toolResult : run.sensitive.redactKnown(toolResult),
                })
            }
        }
        throw new Error('Agent exceeded the maximum of 50 command steps')
    }

    private async executeTool (runtime: AISessionRuntime, run: ActiveRun, toolCall: ToolCall): Promise<string> {
        if (this.isStopped(run)) { throw new DOMException('Agent stopped', 'AbortError') }
        if (this.permissions.mode(runtime) !== 'unrestricted' && !taskRestrictions(run.goal).tools) {
            return JSON.stringify({ error: '本次任务禁止工具调用，工具未执行。' })
        }
        if (toolCall.function.name === 'generate_secret') {
            if (this.permissions.mode(runtime) !== 'unrestricted') {
                return JSON.stringify({ error: '请调用 request_user_input(kind="secret") 索取本次需要的密码，复用已有占位符；不要要求用户解锁保险库。' })
            }
            run.containsSensitiveContext = true
            return JSON.stringify({ value: crypto.randomBytes(32).toString('hex'), sensitive: true, saved: false })
        }
        if (['web_search', 'web_fetch'].includes(toolCall.function.name)) {
            if (!this.web || !run.web) { return JSON.stringify({ error: '联网搜索未启用' }) }
            return this.web.execute(toolCall, run.web, run.controller.signal, content => run.sensitive.protect(content), async event => {
                if (this.isStopped(run)) { throw new DOMException('Agent stopped', 'AbortError') }
                await this.sessions.append(runtime, 'web-activity', event, run.id)
            })
        }
        if (toolCall.function.name === 'configuration_status') { return this.inspectConfiguration(runtime, run, toolCall) }
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
        const taskError = this.permissions.mode(runtime) === 'unrestricted' ? undefined : taskCommandReason(run.goal, argumentsValue.command, run.operationFailed)
        if (taskError) { throw new CommandBlockedError(taskError, argumentsValue.command) }
        const credentialError = credentialAccessReason(argumentsValue.command, this.permissions.mode(runtime))
        if (credentialError) {
            throw new CommandBlockedError('凭证保护：' + credentialError, argumentsValue.command)
        }
        let command = run.sensitive.protect(argumentsValue.command.trim())
        if (!command) { return JSON.stringify({ error: 'Command must not be empty' }) }
        const reason = run.sensitive.protect(argumentsValue.reason.trim())
        const authorization = this.permissions.snapshot(runtime)
        let decision = this.policy.evaluate(command, runtime.shellKind, authorization.policy)
        let approvedCommand: string|undefined = undefined
        await this.sessions.append(runtime, 'ai-command', { command, reason, risk: decision.risk,
            riskDescription: commandRiskDescription(command, decision.risk), permissionMode: authorization.mode }, run.id)

        const action = approvalAction(decision.risk, authorization.mode)
        if (action === 'deny') {
            throw new CommandBlockedError('本地规则禁止此命令：' + decision.reason + (decision.matchedRule ? ' 匹配规则：' + decision.matchedRule : ''), command)
        }
        if (action === 'ask') {
            runtime.state.next('WAITING_APPROVAL')
            const response = await this.interactions.request({
                sessionId: runtime.id,
                connectionId: runtime.connectionId,
                runId: run.id,
                command,
                reason,
                riskDescription: commandRiskDescription(command, decision.risk),
                risk: decision.risk,
                confirmationsRequired: decision.risk === 'DANGEROUS' ? 2 : 1,
            })
            if (response.approved) {
                const editedError = credentialAccessReason(response.command, this.permissions.mode(runtime))
                if (editedError) { throw new CommandBlockedError('修改后的命令触发凭证保护：' + editedError, response.command) }
            }
            const protectedEditedCommand = run.sensitive.protect(response.command.trim())
            await this.sessions.append(runtime, 'approval', {
                approved: response.approved,
                originalCommand: command,
                finalCommand: protectedEditedCommand,
                permissionMode: authorization.mode,
            }, run.id)
            if (!response.approved) {
                throw new UserRejectedError('你已拒绝命令，未执行，本轮已结束。')
            }
            const originalDecision = decision
            command = protectedEditedCommand
            if (!command) { return JSON.stringify({ error: 'Command must not be empty' }) }
            decision = this.policy.evaluate(command, runtime.shellKind, authorization.policy)
            if (isHigherRisk(decision, originalDecision)) {
                return this.executeReclassifiedCommand(runtime, run, command, reason, decision, authorization)
            }
            approvedCommand = command
        } else {
            await this.sessions.append(runtime, 'approval', {
                approved: true, automatic: true, finalCommand: command,
                permissionMode: authorization.mode, risk: decision.risk,
            }, run.id)
        }

        return this.executeApprovedCommand(runtime, run, command, reason, decision, authorization, approvedCommand)
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
            throw new CommandBlockedError('本地规则禁止修改后的命令：' + decision.reason + (decision.matchedRule ? ' 匹配规则：' + decision.matchedRule : ''), command)
        }
        const response = await this.interactions.request({
            sessionId: runtime.id,
            connectionId: runtime.connectionId,
            runId: run.id,
            command,
            reason: '修改后的命令需要重新确认。' + reason,
            riskDescription: commandRiskDescription(command, decision.risk),
            risk: decision.risk,
            confirmationsRequired: decision.risk === 'DANGEROUS' ? 2 : 1,
        })
        if (response.approved) {
            const editedError = credentialAccessReason(response.command, this.permissions.mode(runtime))
            if (editedError) { throw new CommandBlockedError('修改后的命令触发凭证保护：' + editedError, response.command) }
        }
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
            throw new UserRejectedError('你已拒绝修改后的命令，未执行，本轮已结束。')
        }
        if (!protectedEditedCommand) { return JSON.stringify({ error: 'Command must not be empty' }) }
        const finalDecision = this.policy.evaluate(protectedEditedCommand, runtime.shellKind, authorization.policy)
        if (isHigherRisk(finalDecision, decision)) {
            return this.executeReclassifiedCommand(runtime, run, protectedEditedCommand, reason, finalDecision, authorization)
        }
        return this.executeApprovedCommand(runtime, run, protectedEditedCommand, reason, finalDecision, authorization, protectedEditedCommand)
    }

    private async executeApprovedCommand (
        runtime: AISessionRuntime,
        run: ActiveRun,
        command: string,
        reason: string,
        decision: CommandPolicyDecision,
        authorization: CommandAuthorization,
        approvedCommand?: string,
    ): Promise<string> {
        const mode = this.permissions.mode(runtime)
        const taskError = mode === 'unrestricted' ? undefined : taskCommandReason(run.goal, command, run.operationFailed)
        if (taskError) { throw new CommandBlockedError(taskError, command) }
        const secretError = mode === 'unrestricted' ? undefined : run.sensitive.useReason(command)
        if (secretError) { throw new CommandBlockedError(secretError, command) }
        if (mode !== authorization.mode) {
            throw new CommandBlockedError('执行权限已变化，命令未执行。请按新权限重新提交所需命令进行检查。', command)
        }
        const credentialError = credentialAccessReason(command, mode)
        if (credentialError) { throw new CommandBlockedError('凭证保护：' + credentialError, command) }
        if (this.isStopped(run) || runtime.tab.session !== run.session) {
            throw new DOMException('Agent stopped before command execution', 'AbortError')
        }
        const rechecked = this.policy.evaluate(command, runtime.shellKind, authorization.policy)
        const current = this.policy.evaluate(command, runtime.shellKind)
        if (isHigherRisk(rechecked, decision)) { decision = rechecked }
        if (mode !== 'unrestricted' && isHigherRisk(current, decision)) {
            throw new CommandBlockedError('执行规则已收紧，命令未执行：' + current.reason + (current.matchedRule ? ' 匹配规则：' + current.matchedRule : ''), command)
        }
        const action = approvalAction(decision.risk, authorization.mode)
        if (action === 'deny') {
            throw new CommandBlockedError('本地规则禁止此命令：' + decision.reason + (decision.matchedRule ? ' 匹配规则：' + decision.matchedRule : ''), command)
        }
        if (action === 'ask' && approvedCommand !== command) {
            throw new CommandBlockedError('本条命令尚未获得审批，请通过 terminal_exec 重新提交，等待当前权限要求的审批。', command)
        }
        runtime.state.next('EXECUTING')
        await this.sessions.append(runtime, 'ssh-input', { content: command, source: 'ai', reason,
            riskDescription: commandRiskDescription(command, decision.risk, mode === 'unrestricted') }, run.id)
        if (!runtime.independentExecution) { await this.presenter.interrupt(run.id) }
        try {
            run.executingAuthorization = authorization
            let executableCommand = ''
            try { executableCommand = run.sensitive.restoreCommand(command, runtime.shellKind) } catch (error) {
                throw new CommandBlockedError(getErrorMessage(error), command)
            }
            const opaque = mode !== 'unrestricted' && opaqueConfigurationCommand(command)
            const outputFilter = opaque ? Object.assign(() => '', { flush: () => '' }) : run.sensitive.streamFilter(true)
            const result = await this.terminal.execute(runtime, executableCommand, (prompt, kind) =>
                this.handleInteractivePrompt(runtime, run, prompt, kind), run.controller.signal,
            outputFilter, () => {
                if (this.permissions.mode(runtime) !== mode) { throw new CommandBlockedError('执行权限已变化，命令未执行。请按新权限重新提交所需命令进行检查。', command) }
            })
            if (result.exitCode !== 0 && /\b(?:nohup|systemctl\s+(?:start|restart)|service\s+[^;\n]+\s+(?:start|restart)|docker(?:-compose|\s+compose)[^;\n]*\bup|(?:npm|yarn)\s+(?:run\s+)?start|pm2\s+(?:start|restart)|(?:sh|bash|python[\d.]*|node)\s+[^;\n]*\.(?:sh|py|js))\b/.test(command)) { run.operationFailed = true }
            await this.sessions.append(runtime, 'command-result', { exitCode: result.exitCode, handedOff: run.stopRequested }, run.id)
            runtime.state.next('OBSERVING')
            if (run.stopRequested) {
                throw new DOMException('Agent stopped after command completion', 'AbortError')
            }
            const output = opaque ? '已执行配置启动操作。为保护已有配置，原始输出不发送给模型；请用 compose ps 或健康检查确认服务状态。' : run.sensitive.protect(result.output)
            const unrestricted = this.permissions.mode(runtime) === 'unrestricted'
            // Raw SSH history stays local. Only this protected result copy may be
            // included in subsequent model context, including after a restart.
            if (!unrestricted) { await this.sessions.append(runtime, 'model-output', { content: output, exitCode: result.exitCode }, run.id) }
            if (unrestricted) { run.containsSensitiveContext = true }
            return JSON.stringify({ exitCode: result.exitCode, output })
        } finally {
            run.executingAuthorization = undefined
            if (!run.stopRequested && !run.controller.signal.aborted) {
                await this.presenter.open(runtime, run.id, () => this.stop(runtime), this.nextEventSeq(runtime))
            }
        }
    }

    private async inspectConfiguration (runtime: AISessionRuntime, run: ActiveRun, tool: ToolCall): Promise<string> {
        const mode = this.permissions.mode(runtime)
        if (mode !== 'unrestricted' && !taskRestrictions(run.goal).commands) { return JSON.stringify({ error: '当前任务不允许服务器操作，配置检查未执行。' }) }
        let args: { path?: unknown, keys?: unknown } = {}
        try { args = JSON.parse(tool.function.arguments) } catch { return JSON.stringify({ error: '配置检查参数无效。' }) }
        const roots = configurationRoots(args.path, run.goal, run.projectPaths)
        if (!roots.length || !validConfigurationKeys(args.keys) || typeof args.path !== 'string') {
            return JSON.stringify({ error: '请先让用户提供项目目录，并仅检查该目录中的明确配置路径和所需字段名。' })
        }
        const command = configurationCommand(args.path, args.keys, roots, runtime.shellKind ?? 'bash')
        let raw = ''
        const filter = Object.assign((content: string) => { raw += content; if (raw.length > 65536) { raw = '[INVALID_RESULT]' } return '' }, { flush: () => '' })
        runtime.state.next('EXECUTING')
        await this.sessions.append(runtime, 'ai-message', { content: '检查项目配置字段是否齐全，密码和令牌内容不会发给模型。' }, run.id)
        if (!runtime.independentExecution) { await this.presenter.interrupt(run.id) }
        try {
            const result = await this.terminal.execute(runtime, command, undefined, run.controller.signal, filter, () => {
                if (this.isStopped(run) || runtime.tab.session !== run.session || this.permissions.mode(runtime) !== mode) { throw new Error('连接、任务或权限已变化，配置检查未执行') }
            })
            const summary = result.exitCode === 0 ? configurationSummary(raw, args.keys) : { error: '配置检查不可用，请确认服务器 python3 可用；已有配置仍可由应用直接使用。' }
            await this.sessions.append(runtime, 'ssh-output', { content: JSON.stringify(summary), source: 'configuration-status' }, run.id)
            return JSON.stringify(summary)
        } finally {
            raw = ''
            if (!run.stopRequested && !run.controller.signal.aborted) {
                await this.presenter.open(runtime, run.id, () => this.stop(runtime), this.nextEventSeq(runtime))
            }
        }
    }

    private async requestUserInput (runtime: AISessionRuntime, run: ActiveRun, toolCall: ToolCall): Promise<string> {
        let argumentsValue: { prompt?: unknown, kind?: unknown, program?: unknown, target?: unknown } = {}
        try {
            argumentsValue = JSON.parse(toolCall.function.arguments)
        } catch (error) {
            return JSON.stringify({ error: `Invalid tool arguments: ${String(error)}` })
        }
        if (typeof argumentsValue.prompt !== 'string' || !['text', 'secret'].includes(String(argumentsValue.kind))) {
            return JSON.stringify({ error: 'request_user_input requires a prompt and kind of text or secret' })
        }
        const unrestricted = this.permissions.mode(runtime) === 'unrestricted'
        const binding = argumentsValue.kind === 'secret' && !unrestricted ? validateSecretBinding(argumentsValue.program, argumentsValue.target) : undefined
        if (argumentsValue.kind === 'secret' && !unrestricted && (!binding || !taskRestrictions(run.goal).commands)) {
            return JSON.stringify({ error: '本地密码框必须明确 program 和 target，且当前任务需要执行操作。不要索取无用途的秘密。' })
        }
        runtime.state.next('WAITING_INTERACTION')
        const form = await this.interactions.requestForm({
            sessionId: runtime.id,
            connectionId: runtime.connectionId,
            runId: run.id,
            prompt: binding ? argumentsValue.prompt + '\n用途：' + binding.program + '\n授权目标：' + binding.target : argumentsValue.prompt,
            kind: argumentsValue.kind === 'secret' ? 'password' : 'text',
        })
        runtime.state.next('THINKING')
        if (!form.submitted) {
            throw new UserRejectedError('User cancelled the requested input')
        }
        if (argumentsValue.kind === 'secret') {
            const value = form.value
            const placeholder = binding ? run.sensitive.registerSecret(value, binding) : run.sensitive.register(value)
            await this.sessions.append(runtime, 'interaction', {
                prompt: argumentsValue.prompt,
                kind: 'secret',
                response: '[SENSITIVE_VALUE_PROVIDED_LOCALLY]',
            }, run.id)
            return JSON.stringify({ value: placeholder, sensitive: true })
        }
        run.projectPaths = [...run.projectPaths ?? [], ...projectPaths(form.value)]
        const value = run.sensitive.protect(form.value)
        await this.sessions.append(runtime, 'interaction', {
            prompt: binding ? argumentsValue.prompt + '\n用途：' + binding.program + '\n授权目标：' + binding.target : argumentsValue.prompt,
            kind: 'text',
            response: value,
        }, run.id)
        return JSON.stringify({ value, sensitive: value !== form.value })
    }

    private recordRequest (runtime: AISessionRuntime, run: ActiveRun, body: string, model: string, source: string): void {
        const requests = [...runtime.modelRequests ?? [], { sessionId: runtime.id, runId: run.id, source, model, body,
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }].slice(-5)
        while (requests.length > 1 && requests.reduce((sum, request) => sum + request.body.length, 0) > 2000000) { requests.shift() }
        runtime.modelRequests = requests
        runtime.state.next(runtime.state.value)
    }

    private async handleInteractivePrompt (
        runtime: AISessionRuntime,
        run: ActiveRun,
        prompt: string,
        kind: InteractivePromptKind,
    ): Promise<string|null> {
        runtime.state.next('WAITING_INTERACTION')
        let value: string|null = null
        const mode = this.permissions.mode(runtime)
        if (kind === 'yes-no' && run.executingAuthorization?.mode === mode && ['full', 'unrestricted'].includes(mode)) {
            await this.sessions.append(runtime, 'interaction', { prompt: run.sensitive.protect(prompt), kind, response: 'y', automatic: true, permissionMode: mode }, run.id)
            runtime.state.next('EXECUTING')
            return /yes\s*\/\s*no/i.test(prompt) ? 'yes' : 'y'
        }
        await this.presenter.open(runtime, run.id, () => this.stop(runtime), this.nextEventSeq(runtime))
        try {
            const form = await this.interactions.requestForm({
                sessionId: runtime.id,
                connectionId: runtime.connectionId,
                runId: run.id,
                prompt: run.sensitive.protect(prompt),
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
        await this.sessions.append(runtime, 'ai-message', { content, partial: true,
            localOnly: !!run.containsSensitiveContext || this.permissions.mode(runtime) === 'unrestricted' }, run.id)
        runtime.liveText.next('')
    }
}
