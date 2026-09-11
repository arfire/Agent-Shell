import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { SSHTabComponent } from 'tabby-ssh'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { CommandExecutionResult, CommandOutputFilter, InteractivePromptKind } from './command-framing.middleware'
import { detectShellKind, TerminalMode, ShellKind } from './shell-integration'
import { executeSSH } from './ssh-exec'

export type AIRequestHandler = (input: string) => void

interface TerminalAttachment {
    session: NonNullable<SSHTabComponent['session']>
    subscriptions: Subscription[]
    request: AIRequestHandler
    executing: boolean
    controller?: AbortController
}

/** The PTY belongs exclusively to the user. Agent work uses separate exec channels. */
@Injectable({ providedIn: 'root' })
export class TerminalControllerService {
    private attachments = new Map<SSHTabComponent, TerminalAttachment>()

    constructor (private sessions: AISessionService) { }

    async attach (tab: SSHTabComponent, runtime: AISessionRuntime, request: AIRequestHandler): Promise<void> {
        await this.attachMiddleware(tab, runtime, request)
    }

    async attachMiddleware (tab: SSHTabComponent, runtime: AISessionRuntime, request: AIRequestHandler): Promise<void> {
        if (!tab.session || this.attachments.get(tab)?.session === tab.session) { return }
        this.detach(tab)
        runtime.independentExecution = true
        runtime.approvalMode = undefined
        runtime.terminal.next({ mode: 'agent', ready: false, state: 'initializing', notice: '正在准备 Agent…' })
        const attachment: TerminalAttachment = { session: tab.session, subscriptions: [], request, executing: false }
        this.attachments.set(tab, attachment)
        attachment.subscriptions.push(tab.session.ready$.subscribe(() => { void this.retryIntegration(runtime) }))
        attachment.subscriptions.push(tab.session.closed$.subscribe(() => {
            runtime.stopAgent?.()
            this.detach(tab)
        }))
    }

    detach (tab: SSHTabComponent): void {
        const attachment = this.attachments.get(tab)
        if (!attachment) { return }
        attachment.controller?.abort(new Error('SSH 连接已断开'))
        attachment.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.attachments.delete(tab)
        const runtime = this.sessions.get(tab)
        runtime?.terminal.next({ ...runtime.terminal.value, ready: false, state: 'closed', notice: 'SSH 连接已断开' })
    }

    sendRequest (runtime: AISessionRuntime, input: string): boolean {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment || !runtime.terminal.value.ready || runtime.terminal.value.mode !== 'agent' ||
            runtime.locked || !!runtime.activeRunId || !input.trim()) { return false }
        attachment.request(input.trim())
        return true
    }

    async setMode (runtime: AISessionRuntime, mode: TerminalMode): Promise<void> {
        if (mode === 'shell') { runtime.stopAgent?.() }
        runtime.terminal.next({ ...runtime.terminal.value, mode })
    }

    isExecuting (runtime: AISessionRuntime): boolean {
        return this.attachments.get(runtime.tab)?.executing ?? false
    }

    async retryIntegration (runtime: AISessionRuntime): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment || !!runtime.activeRunId || !attachment.session.open) { return }
        try {
            const identity = await runtime.tab.sshSession?.probeShell()
            if (this.attachments.get(runtime.tab) !== attachment) { return }
            const kind = detectShellKind(identity ?? '')
            if (!kind) { throw new Error('暂不支持此服务器的默认 Shell') }
            runtime.shellKind = kind
            runtime.terminal.next({ ...runtime.terminal.value, ready: true, state: 'prompt', notice: '', failureReason: '' })
        } catch (error) {
            if (this.attachments.get(runtime.tab) !== attachment) { return }
            runtime.terminal.next({ ...runtime.terminal.value, ready: false, state: 'unavailable', notice: 'Agent 暂不可用，终端仍可正常使用', failureReason: String(error) })
        }
    }

    canRestoreHistory (runtime: AISessionRuntime): boolean {
        return !!this.attachments.get(runtime.tab) && !runtime.activeRunId && !this.isExecuting(runtime)
    }

    // Independent Agent output never writes into xterm.
    setLocalPresentation (_runtime: AISessionRuntime, _active: boolean): void { /* Output stays in the Agent panel. */ }
    releaseControl (runtime: AISessionRuntime): void { this.attachments.get(runtime.tab)?.controller?.abort() }
    async waitForPrompt (runtime: AISessionRuntime, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted()
        if (!this.attachments.get(runtime.tab)?.session.open) { throw new Error('SSH 连接未就绪') }
    }

    async restorePrompt (_runtime: AISessionRuntime): Promise<void> { /* The remote prompt is never overwritten. */ }

    async execute (
        runtime: AISessionRuntime, command: string,
        _onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>,
        signal?: AbortSignal, outputFilter?: CommandOutputFilter, beforeExecute?: () => void,
    ): Promise<CommandExecutionResult> {
        const attachment = this.attachments.get(runtime.tab)
        const ssh = runtime.tab.sshSession
        const shell = runtime.shellKind
        if (!attachment?.session.open || !ssh || !shell) { throw new Error('SSH 执行通道未就绪') }
        if (attachment.executing) { throw new Error('已有 Agent 命令正在执行') }
        signal?.throwIfAborted()
        beforeExecute?.()
        attachment.executing = true
        const controller = new AbortController()
        attachment.controller = controller
        const abort = (): void => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        let output = ''
        let saving = Promise.resolve()
        const append = (content: string): void => {
            if (!content) { return }
            output = (output + content).slice(-262144)
            saving = saving.then(async () => {
                await this.sessions.append(runtime, 'ssh-output', { content, source: 'ai' }, runtime.activeRunId)
            })
        }
        try {
            const result = await executeSSH(() => ssh.openExecChannel(), command, shell as ShellKind,
                text => append(outputFilter ? outputFilter(text) : text), controller.signal)
            append(outputFilter?.flush?.() ?? '')
            return { exitCode: result.exitCode, output }
        } finally {
            append(outputFilter?.flush?.() ?? '')
            try { await saving } finally {
                signal?.removeEventListener('abort', abort)
                attachment.executing = false
                attachment.controller = undefined
            }
        }
    }
}
