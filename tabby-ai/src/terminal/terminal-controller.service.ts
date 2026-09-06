import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { ToastrService } from 'ngx-toastr'
import { SSHTabComponent } from 'tabby-ssh'
import { XTermFrontend } from 'tabby-terminal'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { AIConfigService } from '../config/ai-config.service'
import { AIInputDetector } from './input-detector'
import { AIInputMiddleware, InputRoute } from './ai-input.middleware'
import { CommandExecutionResult, CommandFramingMiddleware, InteractivePromptKind } from './command-framing.middleware'
import { ShellIntegration, detectShellKind, TerminalMode } from './shell-integration'

export type AIRequestHandler = (input: string, middleware: AIInputMiddleware) => void

interface TerminalAttachment {
    input: AIInputMiddleware
    framing: CommandFramingMiddleware
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
        const session = tab.session
        const integration = new ShellIntegration(async () => { await tab.write('') })
        const input = new AIInputMiddleware(runtime, this.sessions, this.detector, integration,
            value => onAIRequest(value, input),
            () => this.toastr.info(integration.notice.value || 'Agent 正在操作终端，请使用底部操作面板'))
        const framing = new CommandFramingMiddleware()
        // Remote -> integration -> framing -> local editor -> capture -> xterm.
        session.middleware.unshift(input)
        session.middleware.unshift(framing)
        session.middleware.unshift(integration)
        const update = (): void => runtime.terminal.next({
            mode: integration.mode.value,
            ready: input.canCapture,
            notice: integration.notice.value,
            state: integration.state.value,
        })
        const pasteListener = (event: ClipboardEvent): void => {
            if (input.pasteText(event.clipboardData?.getData('text/plain') ?? '')) {
                event.preventDefault()
                event.stopImmediatePropagation()
            }
        }
        const subscriptions = [
            integration.mode.subscribe(update), integration.state.subscribe(update),
            integration.prompt.subscribe(() => {
                framing.promptReady()
                if (!integration.promptText && tab.frontend instanceof XTermFrontend) {
                    const buffer = tab.frontend.xterm.buffer.active
                    integration.promptText = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? ''
                }
            }),
            integration.notice.subscribe(update), runtime.state.subscribe(update),
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
        this.attachments.set(tab, { input, framing, integration, subscriptions, session, pasteListener })
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
                    integration.fail('Shell 集成不可用，已切回原本模式：' + String(error))
                }
            })
        }))
    }

    detach (tab: SSHTabComponent): void {
        const attachment = this.attachments.get(tab)
        if (!attachment) { return }
        this.attachments.delete(tab)
        const runtime = this.sessions.get(tab)
        if (runtime) {
            runtime.terminal.next({ ...runtime.terminal.value, ready: false, state: 'closed', notice: 'SSH 连接已断开' })
        }
        attachment.subscriptions.forEach(subscription => subscription.unsubscribe())
        tab.content?.nativeElement.removeEventListener('paste', attachment.pasteListener, true)
        tab.localPasteHandler = undefined
        for (const middleware of [attachment.integration, attachment.framing, attachment.input]) {
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
            attachment.integration.disable()
            runtime.locked = false
            const message = running
                ? 'Agent 已停止后续操作，当前程序仍在运行，终端已交由你控制；如需中断，请按 Ctrl+C。'
                : '已切回原本模式，键盘输入直接发送 Shell。'
            attachment.integration.notice.next(message)
            this.toastr.info(message)
        }
    }

    isExecuting (runtime: AISessionRuntime): boolean {
        return this.attachments.get(runtime.tab)?.framing.isExecuting ?? false
    }

    setLocalPresentation (runtime: AISessionRuntime, active: boolean): void {
        const attachment = this.attachments.get(runtime.tab)
        if (attachment) { attachment.integration.localPresentation = active }
    }

    releaseControl (runtime: AISessionRuntime): void {
        this.attachments.get(runtime.tab)?.framing.releaseControl()
    }

    async waitForPrompt (runtime: AISessionRuntime, signal?: AbortSignal): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment) { throw new Error('SSH session is not attached') }
        await attachment.integration.waitForPrompt(signal)
    }

    async restorePrompt (runtime: AISessionRuntime): Promise<void> {
        const attachment = this.attachments.get(runtime.tab)
        if (attachment?.integration.mode.value === 'agent' && !attachment.framing.isExecuting) {
            await attachment.integration.redraw()
        }
    }

    async execute (
        runtime: AISessionRuntime, command: string,
        onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>,
        signal?: AbortSignal, outputFilter?: (content: string) => string,
    ): Promise<CommandExecutionResult> {
        const attachment = this.attachments.get(runtime.tab)
        if (!attachment) { throw new Error('AI terminal middleware is not attached') }
        await attachment.integration.waitForPrompt(signal)
        await attachment.integration.redraw()
        if (signal?.aborted) { throw signal.reason }
        await runtime.tab.write('\r\n')
        attachment.integration.commandStarted()
        return attachment.framing.execute(command, attachment.input, onPrompt, signal, outputFilter, attachment.integration.kind ?? 'bash')
    }
}
