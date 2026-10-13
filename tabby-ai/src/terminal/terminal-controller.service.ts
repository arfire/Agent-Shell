import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { ToastrService } from 'ngx-toastr'
import { SSHTabComponent } from 'tabby-ssh'
import { XTermFrontend } from 'tabby-terminal'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { AIConfigService } from '../config/ai-config.service'
import { AIInputDetector } from './input-detector'
import { AIInputMiddleware, InputRoute } from './ai-input.middleware'
import { CommandExecutionResult, CommandOutputFilter, InteractivePromptKind } from './command-framing.middleware'
import { ShellIntegration, detectShellKind, TerminalMode, ShellKind } from './shell-integration'
import { executeSSH } from './ssh-exec'

export type AIRequestHandler = (input: string, middleware: AIInputMiddleware) => void

interface TerminalAttachment {
    input: AIInputMiddleware
    executing: boolean
    controller?: AbortController
    integration: ShellIntegration
    subscriptions: Subscription[]
    session: NonNullable<SSHTabComponent['session']>
    pasteListener: (event: ClipboardEvent) => void
}

@Injectable({ providedIn: 'root' })
export class TerminalControllerService {
    private attachments = new Map<SSHTabComponent, TerminalAttachment>()

    constructor (
        private sessions: AISessionService,
        private detector: AIInputDetector,
        private config: AIConfigService,
        private toastr: ToastrService,
    ) { }

    async attach (tab: SSHTabComponent, runtime: AISessionRuntime, onAIRequest: AIRequestHandler): Promise<void> {
        await this.attachMiddleware(tab, runtime, onAIRequest)
    }

    async attachMiddleware (tab: SSHTabComponent, runtime: AISessionRuntime, onAIRequest: AIRequestHandler): Promise<void> {
        if (!tab.session || this.attachments.get(tab)?.session === tab.session) { return }
        this.detach(tab)
        runtime.independentExecution = true
        runtime.approvalMode = undefined
        const session = tab.session
        const integration = new ShellIntegration(async () => {
            await tab.write('')
            if (tab.frontend instanceof XTermFrontend) {
                await new Promise<void>(resolve => (tab.frontend as XTermFrontend).xterm.write('', resolve))
            }
        })
        const input = new AIInputMiddleware(runtime, this.sessions, this.detector, integration,
            value => onAIRequest(value, input),
            () => this.toastr.info(integration.notice.value || 'Agent 正在操作终端，请使用底部操作面板'))
        // Only user input uses the PTY editor; Agent commands retain separate SSH exec channels.
        session.middleware.unshift(input)
        session.middleware.unshift(integration)
        const update = (): void => {
            const next = {
                mode: integration.mode.value,
                ready: input.canCapture,
                notice: integration.notice.value,
                state: integration.state.value,
                failureReason: integration.failureReason.value,
            }
            const previous = runtime.terminal.value
            if (previous.mode !== next.mode || previous.ready !== next.ready || previous.notice !== next.notice ||
                previous.state !== next.state || previous.failureReason !== next.failureReason) {
                runtime.terminal.next(next)
            }
        }
        const pasteListener = (event: ClipboardEvent): void => {
            if (input.pasteText(event.clipboardData?.getData('text/plain') ?? '')) {
                event.preventDefault()
                event.stopImmediatePropagation()
            }
        }
        let userCommandPending = false
        const subscriptions = [
            integration.command.subscribe(command => {
                if (!runtime.activeRunId && command.trim() && !command.trimStart().startsWith('__ash_')) {
                    userCommandPending = true
                    if (input.readlineOwned) {
                        void this.sessions.append(runtime, 'ssh-input', { content: command, source: 'user' })
                    }
                }
            }),
            integration.commandFinished.subscribe(exitCode => {
                if (userCommandPending) {
                    userCommandPending = false
                    void this.sessions.append(runtime, 'command-result', { exitCode, source: 'user' })
                }
            }),
            integration.mode.subscribe(update), integration.state.subscribe(update),
            integration.prompt.subscribe(() => {
                if (integration.workingDirectory) { session.reportWorkingDirectory(integration.workingDirectory) }
                if (!integration.promptText && tab.frontend instanceof XTermFrontend) {
                    const buffer = tab.frontend.xterm.buffer.active
                    integration.promptText = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? ''
                }
            }),
            integration.notice.subscribe(update), integration.failureReason.subscribe(update), runtime.state.subscribe(update),
            tab.alternateScreenActive$.subscribe(active => integration.setAlternateScreen(active)),
            session.closed$.subscribe(() => {
                runtime.stopAgent?.()
                this.detach(tab)
            }),
        ]
        if (tab.frontend instanceof XTermFrontend) {
            subscriptions.push(tab.frontend.keyEvent$.subscribe(event => {
                if (event.type !== 'keydown' || event.isComposing || !input.canCapture) { return }
                const key = [
                    event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '',
                    event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '', event.key,
                ].filter(Boolean).join('+')
                const detection = this.config.config.inputDetection
                const route = key === (detection.forceAgentShortcut ?? 'Shift+Enter') ? 'agent'
                    : key === (detection.forceShellShortcut ?? 'Ctrl+Enter') ? 'shell' : null
                if (route) {
                    event.preventDefault()
                    event.stopPropagation()
                    input.submit(route)
                }
            }))
        }
        tab.content.nativeElement.addEventListener('paste', pasteListener, true)
        tab.localPasteHandler = text => input.pasteText(text)
        this.attachments.set(tab, { input, executing: false, integration, subscriptions, session, pasteListener })
        subscriptions.push(session.ready$.subscribe(() => {
            void this.config.ready.then(async () => {
                const identity = await tab.sshSession?.probeShell()
                if (this.attachments.get(tab)?.integration === integration) {
                    const kind = detectShellKind(identity ?? '')
                    runtime.shellKind = kind ?? undefined
                    integration.setShell(kind)
                }
            }).catch(error => {
                if (this.attachments.get(tab)?.integration === integration) {
                    integration.fail('Shell 集成不可用，已切回 Shell 模式：' + String(error))
                }
            })
        }))
    }

    detach (tab: SSHTabComponent): void {
        const attachment = this.attachments.get(tab)
        if (!attachment) { return }
        attachment.controller?.abort(new Error('SSH 连接已断开'))
        this.attachments.delete(tab)
        const runtime = this.sessions.get(tab)
        if (runtime) {
            runtime.terminal.next({ ...runtime.terminal.value, ready: false, state: 'closed', notice: 'SSH 连接已断开' })
        }
        attachment.subscriptions.forEach(subscription => subscription.unsubscribe())
        tab.content?.nativeElement.removeEventListener('paste', attachment.pasteListener, true)
        tab.localPasteHandler = undefined
        for (const middleware of [attachment.integration, attachment.input]) {
            attachment.session.middleware.remove(middleware)
            middleware.close()
        }
    }

    submit (runtime: AISessionRuntime, route: InputRoute): void {
        this.attachments.get(runtime.tab)?.input.submit(route)
        runtime.tab.frontend?.focus()
    }

    async setMode (runtime: AISessionRuntime, mode: TerminalMode): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment || mode === attachment.integration.mode.value) { return }
        if (mode === 'agent') {
            attachment.integration.enable()
        } else {
            const running = this.isExecuting(runtime) || !attachment.integration.ready
            await runtime.handoffAgent?.()
            const hadInput = attachment.input.hasInput
            await attachment.input.handoff()
            if (hadInput) { attachment.integration.commandStarted() }
            attachment.integration.disable(true)
            runtime.locked = false
            const message = running
                ? runtime.independentExecution ? 'Agent 已停止，终端已交由你控制；独立通道中远端进程的状态仍需核实。'
                    : 'Agent 已停止后续操作，当前程序仍在运行，终端已交由你控制；如需中断，请按 Ctrl+C。'
                : '已切回 Shell 模式，键盘输入直接发送 Shell。'
            attachment.integration.notice.next(message)
            this.toastr.info(message)
        }
    }

    isExecuting (runtime: AISessionRuntime): boolean {
        return this.attachments.get(runtime.tab)?.executing ?? false
    }

    async retryIntegration (runtime: AISessionRuntime): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment || !!runtime.activeRunId || runtime.locked || attachment.executing ||
            !attachment.session.open || attachment.integration.state.value !== 'unavailable') { return }
        attachment.integration.enable()
        try {
            const identity = await runtime.tab.sshSession?.probeShell()
            if (this.attachments.get(runtime.tab) !== attachment) { return }
            const kind = detectShellKind(identity ?? '')
            runtime.shellKind = kind ?? undefined
            attachment.integration.setShell(kind)
        } catch (error) {
            if (this.attachments.get(runtime.tab) === attachment) {
                attachment.integration.fail('无法识别 Shell，已切回 Shell 模式：' + String(error))
            }
        }
    }

    canRestoreHistory (runtime: AISessionRuntime): boolean {
        const attachment = this.attachments.get(runtime.tab)
        return !!attachment && attachment.integration.mode.value === 'agent' && attachment.integration.ready &&
            !attachment.integration.alternateScreen && !attachment.input.hasInput && !attachment.input.remoteEditing &&
            !attachment.executing
    }

    canPresent (runtime: AISessionRuntime): boolean {
        const attachment = this.attachments.get(runtime.tab)
        return !!attachment && attachment.integration.ready && !attachment.integration.alternateScreen &&
            !attachment.input.hasInput && !attachment.input.readlineOwned
    }

    setLocalPresentation (runtime: AISessionRuntime, active: boolean): void {
        const attachment = this.attachments.get(runtime.tab)
        if (attachment) { attachment.integration.localPresentation = active }
    }

    releaseControl (runtime: AISessionRuntime): void {
        this.attachments.get(runtime.tab)?.controller?.abort()
    }

    async waitForPrompt (runtime: AISessionRuntime, signal?: AbortSignal): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment) { throw new Error('SSH session is not attached') }
        await attachment.integration.waitForPrompt(signal)
    }

    async restorePrompt (runtime: AISessionRuntime): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (attachment?.integration.mode.value === 'agent' && !attachment.executing &&
            !attachment.input.hasInput && !attachment.input.readlineOwned) {
            await attachment.integration.redraw()
        }
    }

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
