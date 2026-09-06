import { BehaviorSubject, Subject, Subscription } from 'rxjs'
import { StringDecoder } from 'string_decoder'
import * as crypto from 'crypto'
import { SessionMiddleware } from 'tabby-terminal'

import { looksLikeShellPrompt, detectInteractivePrompt } from './interactive-prompt'

export type ShellKind = 'bash'|'zsh'|'fish'|'powershell'
export type TerminalMode = 'agent'|'shell'
export type ShellState = 'initializing'|'prompt'|'remote'|'synchronizing'|'unavailable'|'closed'

const scripts: Record<ShellKind, string> = {
    bash: require('!!raw-loader!./shell-integration/bash.sh').default,
    zsh: require('!!raw-loader!./shell-integration/zsh.sh').default,
    fish: require('!!raw-loader!./shell-integration/fish.fish').default,
    powershell: require('!!raw-loader!./shell-integration/powershell.ps1').default,
}

export function detectShellKind (identity: string): ShellKind|null {
    const start = identity.indexOf('__ASH_SHELL__')
    const line = start < 0 ? '' : identity.slice(start).replace(/[\r\n]+/g, ' ')
    if (/\b(?:Core|Desktop)\b/.test(line)) {
        return 'powershell'
    }
    return (/(?:\/|\s)(bash|zsh|fish)(?:\s|$)/.exec(line)?.[1] ?? null) as ShellKind|null
}

export function shellBootstrap (kind: ShellKind, nonce: string): string {
    const script = scripts[kind].replaceAll('__NONCE__', nonce)
    if (kind === 'powershell') {
        return ` . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))))\r`
    }
    const encoded = Buffer.from(script).toString('base64')
    return kind === 'fish'
        ? ` printf '%s' '${encoded}' | base64 -d | source\r`
        : ` eval "$(printf '%s' '${encoded}' | base64 -d)"\r`
}

/** Only this session's nonce-bearing prompt markers authorize local input capture. */
export class ShellIntegration extends SessionMiddleware {
    readonly mode = new BehaviorSubject<TerminalMode>('agent')
    readonly state = new BehaviorSubject<ShellState>('initializing')
    readonly notice = new BehaviorSubject('正在连接 Shell…')
    readonly prompt = new Subject<void>()
    readonly nonce = crypto.randomBytes(16).toString('hex')
    kind: ShellKind|null = null
    installed = false
    promptText = ''
    ready = false
    alternateScreen = false
    localPresentation = false
    private decoder = new StringDecoder('utf8')
    private pending = ''
    private recent = ''
    private capturingPrompt = false
    private sentBootstrap = false
    private hidden = ''
    private timer?: ReturnType<typeof setTimeout>
    private generation = 0
    private uninstallPending = false
    private uninstalling = false
    private enableAfterUninstall = false
    private promptTimer?: ReturnType<typeof setTimeout>
    private promptPending = false

    constructor (private drain: () => Promise<void>) {
        super()
        this.timer = setTimeout(() => this.fail('未能确认 Shell 就绪，已切回原本模式'), 12000)
    }

    setShell (kind: ShellKind|null): void {
        this.kind = kind
        if (!kind) {
            this.fail('当前 Shell 暂不支持 Agent 自动识别，已切回原本模式')
        } else {
            this.tryBootstrap()
        }
    }

    feedFromSession (data: Buffer): void {
        const value = this.decoder.write(data)
        this.recent = (this.recent + value).slice(-4096)
        this.pending += value
        while (this.pending) {
            const start = this.pending.indexOf('\x1b]')
            if (start < 0) {
                const hold = this.pending.endsWith('\x1b') ? 1 : 0
                this.emit(this.pending.slice(0, this.pending.length - hold))
                this.pending = hold ? '\x1b' : ''
                break
            }
            if (start > 0) {
                this.emit(this.pending.slice(0, start))
                this.pending = this.pending.slice(start)
            }
            const end = /\x07|\x1b\\/.exec(this.pending)
            if (!end) {
                if (this.pending.length > 65536) {
                    this.emit(this.pending)
                    this.pending = ''
                }
                break
            }
            const sequence = this.pending.slice(0, end.index + end[0].length)
            const body = this.pending.slice(2, end.index)
            this.pending = this.pending.slice(sequence.length)
            const prefix = `777;ash;${this.nonce};`
            if (body.startsWith(prefix)) {
                this.marker(body.slice(prefix.length))
            } else {
                this.emit(sequence)
            }
        }
        this.tryBootstrap()
        if (this.promptPending) { this.settlePrompt() }
    }

    commandStarted (): void {
        this.ready = false
        this.promptPending = false
        clearTimeout(this.promptTimer)
        this.generation++
        this.state.next('remote')
    }

    setAlternateScreen (active: boolean): void {
        this.alternateScreen = active
        if (active) {
            this.commandStarted()
            this.notice.next('交互程序正在接管终端，键盘直接发送远端')
        }
    }

    async waitForPrompt (signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw signal.reason
        }
        if (this.ready && !this.alternateScreen) {
            await this.drain()
            return
        }
        await new Promise<void>((resolve, reject) => {
            const subscriptions = new Subscription()
            let timer: ReturnType<typeof setTimeout>|undefined = undefined
            const abort = (): void => {
                clearTimeout(timer)
                subscriptions.unsubscribe()
                reject(signal?.reason ?? new Error('Shell disconnected'))
            }
            const finish = (error?: unknown): void => {
                clearTimeout(timer)
                subscriptions.unsubscribe()
                signal?.removeEventListener('abort', abort)
                if (error) { reject(error) } else { resolve() }
            }
            timer = setTimeout(() => finish(new Error('Shell prompt synchronization timed out')), 15000)
            subscriptions.add(this.prompt.subscribe(() => finish()))
            subscriptions.add(this.state.subscribe(state => {
                if (state === 'closed' || state === 'unavailable') {
                    queueMicrotask(abort)
                }
            }))
            signal?.addEventListener('abort', abort, { once: true })
        })
    }

    async redraw (): Promise<void> {
        if (!this.ready || this.alternateScreen || !this.installed) {
            return
        }
        this.commandStarted()
        this.state.next('synchronizing')
        // The remote readline buffer is empty: accepting it requests a real new prompt.
        this.outputToSession.next(Buffer.from('\r'))
        await this.waitForPrompt()
    }

    disable (): void {
        clearTimeout(this.timer)
        this.mode.next('shell')
        this.uninstallPending = this.installed || this.sentBootstrap
        if (this.ready && this.installed) {
            this.uninstall()
        }
    }

    enable (): void {
        if (this.uninstalling) {
            this.enableAfterUninstall = true
            this.notice.next('正在清理上一次 Shell 集成，完成后重新启用')
            return
        }
        if (this.installed) {
            this.uninstallPending = false
            this.mode.next('agent')
            return
        }
        this.mode.next('agent')
        this.sentBootstrap = false
        this.recent = ''
        this.state.next('initializing')
        this.notice.next('请在空提示符下按 Enter，准备 Agent 模式')
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.fail('未能确认空提示符，已切回原本模式'), 12000)
    }

    fail (message: string): void {
        clearTimeout(this.timer)
        clearTimeout(this.promptTimer)
        // Never inject cleanup into a running program or a partially edited remote line.
        // A late READY/B still triggers the pending cleanup after a failed bootstrap.
        this.disable()
        this.ready = false
        this.state.next('unavailable')
        this.notice.next(message)
        if (this.hidden) {
            this.outputToTerminal.next(Buffer.from(this.hidden))
            this.hidden = ''
        }
    }

    close (): void {
        clearTimeout(this.timer)
        clearTimeout(this.promptTimer)
        this.generation++
        this.ready = false
        this.state.next('closed')
        this.prompt.complete()
        this.state.complete()
        this.mode.complete()
        this.notice.complete()
        super.close()
    }

    private tryBootstrap (): void {
        // This check is used only during installation, never to authorize local editing.
        // A separate SSH probe must identify a supported shell, and no user line is sent here.
        if (this.state.value !== 'initializing' || !this.kind || this.sentBootstrap || this.alternateScreen ||
            detectInteractivePrompt(this.recent) !== null || !looksLikeShellPrompt(this.recent)) {
            return
        }
        this.sentBootstrap = true
        this.notice.next('正在启用 Agent 模式…')
        const command = shellBootstrap(this.kind, this.nonce)
        // Encode definitions as one readline entry, without changing the user's shell files.
        this.outputToSession.next(Buffer.from(command))
    }

    private emit (text: string): void {
        if (!text) { return }
        if (this.sentBootstrap && !this.installed && this.state.value === 'initializing') {
            this.hidden = (this.hidden + text).slice(-32768)
            return
        }
        if (this.capturingPrompt) {
            this.promptText = (this.promptText + text).slice(-16384)
            // Readline may repaint its idle prompt on resize while Agent text
            // occupies the cursor. Keep the snapshot, without inserting it in prose.
            if (this.localPresentation) { return }
        }
        this.outputToTerminal.next(Buffer.from(text))
    }

    private marker (value: string): void {
        const [type] = value.split(';')
        if (type === 'READY') {
            this.installed = true
            this.hidden = ''
        } else if (type === 'A') {
            this.capturingPrompt = true
            this.promptText = ''
            this.ready = false
        } else if (type === 'B') {
            this.capturingPrompt = false
            this.promptPending = true
        } else if (type === 'C') {
            this.commandStarted()
        } else if (type === 'U') {
            const restart = this.enableAfterUninstall
            this.installed = false
            this.sentBootstrap = false
            this.uninstallPending = false
            this.uninstalling = false
            this.enableAfterUninstall = false
            this.ready = false
            this.state.next('unavailable')
            if (restart) { this.enable() }
        }
    }

    private settlePrompt (): void {
        clearTimeout(this.promptTimer)
        const generation = this.generation
        // ConPTY can deliver the prompt's glyphs after its OSC marker. Drain a quiet batch.
        this.promptTimer = setTimeout(() => {
            void this.drain().then(() => {
                if (generation !== this.generation || this.alternateScreen || !this.installed) { return }
                this.promptPending = false
                clearTimeout(this.timer)
                this.ready = true
                if (this.uninstallPending) {
                    this.uninstall()
                    return
                }
                this.prompt.next()
                this.state.next('prompt')
                this.notice.next('')
            }).catch(error => this.fail(String(error)))
        }, 40)
    }

    private uninstall (): void {
        if (this.uninstalling) { return }
        this.uninstalling = true
        this.uninstallPending = false
        this.commandStarted()
        this.outputToSession.next(Buffer.from(' __ash_uninstall\r'))
    }
}
