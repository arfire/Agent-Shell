import { SessionMiddleware, XTermFrontend } from 'tabby-terminal'
import { StringDecoder } from 'string_decoder'

import { AIInputDetector, unwrapShellFence } from './input-detector'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { ShellIntegration } from './shell-integration'
import { terminalText } from './terminal-text'

export type InputRoute = 'auto'|'shell'|'agent'

/** Local drafts occupy xterm cells, never a second DOM input or the remote PTY. */
export class AIInputMiddleware extends SessionMiddleware {
    private buffer = ''
    private cursor = 0
    private decoder = new StringDecoder('utf8')
    private escape = ''
    private paste = false
    private pasteContent = ''
    private handedOff = false
    private awaitingPrompt = false
    private closed = false
    private anchor?: { line: number, isDisposed: boolean, dispose: () => void }
    private anchorColumn = 0
    private anchorColumns = 0
    private promptCellOffset = 0
    private queue = Promise.resolve()

    constructor (
        private runtime: AISessionRuntime,
        private sessions: AISessionService,
        private detector: AIInputDetector,
        public readonly integration: ShellIntegration,
        private onAIRequest: (input: string) => void,
        private onBlockedInput: () => void,
    ) {
        super()
        integration.prompt.subscribe(() => {
            if (this.awaitingPrompt || this.integration.mode.value === 'shell') {
                this.handedOff = false
                this.awaitingPrompt = false
            }
            if (!this.buffer) {
                this.anchor?.dispose()
                this.anchor = undefined
            }
        })
    }

    get canCapture (): boolean {
        return !this.closed && this.integration.mode.value === 'agent' && this.integration.ready &&
            !this.integration.alternateScreen && !this.handedOff && !this.runtime.locked
    }

    get hasInput (): boolean { return !!this.buffer }
    get remoteEditing (): boolean { return this.handedOff && !this.awaitingPrompt }
    get readlineOwned (): boolean { return this.handedOff }

    feedFromSession (data: Buffer): void {
        if (this.buffer && this.canCapture) {
            this.enqueue(async () => {
                if (!this.buffer || !this.canCapture) {
                    this.outputToTerminal.next(data)
                    return
                }
                await this.erase()
                this.outputToTerminal.next(data)
                await this.flushTerminal()
                await this.runtime.tab.write('\r\n' + this.integration.promptText)
                await this.flushTerminal()
                this.anchor?.dispose()
                this.anchor = undefined
                this.captureAnchor()
                await this.paint()
            })
        } else {
            this.outputToTerminal.next(data)
        }
    }

    feedFromTerminal (data: Buffer): void {
        // Device/status replies and focus notifications are terminal protocol, not typed drafts.
        if (/^\x1b\[(?:\??\d+;\d+R|[?>]?[\d;]*c|\??\d+;\d+\$y|[IO])$/.test(data.toString())) {
            this.sendAgent(data)
            return
        }
        if (this.integration.mode.value === 'shell' || this.integration.alternateScreen) {
            this.integration.commandStarted()
            this.sendAgent(data)
            return
        }
        if (this.integration.state.value === 'initializing') {
            if (data.equals(Buffer.from('\r')) && !this.buffer) {
                this.sendAgent(data)
            } else {
                this.onBlockedInput()
            }
            return
        }
        if (this.runtime.locked) {
            if (data.equals(Buffer.from([3]))) {
                this.runtime.stopAgent?.()
            } else {
                this.onBlockedInput()
            }
            return
        }
        const input = this.decoder.write(data)
        this.enqueue(async () => {
            // A resize can briefly repaint an otherwise idle prompt (A ... B).
            // This is not remote program ownership: do not leak a draft through
            // the gap before the fresh prompt has settled.
            if (this.integration.mode.value === 'agent' && this.integration.state.value === 'prompt' &&
                !this.integration.ready && !this.handedOff && !this.runtime.locked) {
                await this.integration.waitForPrompt()
            }
            // A preceding queued Enter may have started an Agent run since receipt.
            if (this.runtime.locked && this.integration.mode.value === 'agent' && !this.integration.alternateScreen) {
                if (input === '\x03') { this.runtime.stopAgent?.() } else { this.onBlockedInput() }
                return
            }
            if (this.canCapture && !this.escape && !this.paste && /^[^\x00-\x1f\x7f-\x9f]+$/.test(input)) {
                await this.flushTerminal()
                this.captureAnchor()
                this.insert(input)
                await this.paint()
                return
            }
            if (!this.canCapture && !this.buffer) {
                this.forwardReadline(input)
                return
            }
            for (const character of input) {
                await this.character(character)
            }
        })
    }

    submit (route: InputRoute = 'auto'): void {
        this.enqueue(() => this.submitNow(route))
    }

    forceAI (): void { this.submit('agent') }

    pasteText (text: string): boolean {
        if (!this.canCapture) { return false }
        this.enqueue(async () => {
            if (!this.canCapture) { this.onBlockedInput(); return }
            await this.flushTerminal()
            this.captureAnchor()
            this.insert(text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
            await this.paint()
        })
        return true
    }

    sendAgent (data: string|Buffer): void {
        if (!this.closed) {
            this.outputToSession.next(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
        }
    }

    resetInputBuffer (): void {
        this.buffer = ''
        this.cursor = 0
        this.escape = ''
        this.paste = false
        this.pasteContent = ''
        this.anchor?.dispose()
        this.anchor = undefined
    }

    async handoff (): Promise<void> {
        await this.queue
        if (this.buffer) {
            await this.erase()
            this.sendAgent(this.remoteText(this.buffer))
            this.resetInputBuffer()
        }
        this.handedOff = true
        this.awaitingPrompt = true
    }

    async settled (): Promise<void> { await this.queue; await this.flushTerminal() }

    close (): void {
        this.closed = true
        this.resetInputBuffer()
        this.decoder.end()
        super.close()
    }

    private enqueue (operation: () => Promise<void>): void {
        this.queue = this.queue.then(async () => {
            if (!this.closed) { await operation() }
        }).catch(error => {
            this.integration.notice.next('输入同步失败，输入未提交：' + String(error))
        })
    }

    private async character (character: string): Promise<void> {
        if (this.integration.mode.value === 'agent' && this.integration.state.value === 'prompt' &&
            !this.integration.ready && !this.handedOff && !this.runtime.locked) {
            await this.integration.waitForPrompt()
        }
        if (this.escape) {
            this.escape += character
            if (!/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[^\[O])$/.test(this.escape) && this.escape.length < 64) { return }
            const sequence = this.escape
            this.escape = ''
            if (sequence === '\x1b[200~') {
                this.paste = true
                this.pasteContent = ''
            } else if (sequence === '\x1b[201~' && this.paste) {
                this.paste = false
                this.captureAnchor()
                this.insert(this.pasteContent.replace(/\r\n?/g, '\n'))
                this.pasteContent = ''
                await this.paint()
            } else if (!this.paste) {
                await this.editKey(sequence)
            }
            return
        }
        if (character === '\x1b') { this.escape = character; return }
        if (this.paste) {
            if (character === '\r' || character === '\n' || character === '\t' || character.codePointAt(0)! >= 32) {
                this.pasteContent += character
            }
            return
        }
        if (!this.canCapture) {
            if (!this.runtime.locked) {
                this.forwardReadline(character)
            }
            return
        }
        if (character === '\r' || character === '\n') {
            await this.submitNow('auto')
        } else if (character === '\x03') {
            await this.erase()
            this.resetInputBuffer()
            this.integration.commandStarted()
            this.sendAgent(character)
        } else if (character === '\x7f' || character === '\x08') {
            const previous = this.previousCharacter()
            this.buffer = this.buffer.slice(0, previous) + this.buffer.slice(this.cursor)
            this.cursor = previous
            await this.paint()
        } else if (character === '\x15') {
            this.buffer = this.buffer.slice(this.cursor)
            this.cursor = 0
            await this.paint()
        } else if (character === '\x17') {
            const prefix = this.buffer.slice(0, this.cursor).replace(/\s*\S+\s*$/, '')
            this.buffer = prefix + this.buffer.slice(this.cursor)
            this.cursor = prefix.length
            await this.paint()
        } else if (character.codePointAt(0)! < 32) {
            await this.editKey(character)
        } else {
            this.captureAnchor()
            this.insert(character)
            await this.paint()
        }
    }

    private async submitNow (route: InputRoute): Promise<void> {
        if (!this.canCapture) { this.onBlockedInput(); return }
        const input = this.buffer
        const shell = route === 'shell' || !input.trim() || route === 'auto' && this.detector.isShellCommand(input, this.integration.kind ?? undefined)
        if (shell) {
            await this.erase()
            this.resetInputBuffer()
            this.integration.commandStarted()
            void this.sessions.append(this.runtime, 'ssh-input', { content: input, source: 'user' })
            this.sendAgent(this.remoteText(route === 'auto' ? unwrapShellFence(input) : input) + '\r')
        } else {
            this.cursor = this.buffer.length
            await this.paint()
            this.resetInputBuffer()
            this.runtime.locked = true
            await this.runtime.tab.write('\r\n')
            this.onAIRequest(input)
        }
    }

    private remoteText (input: string): string {
        return input.includes('\n') && this.runtime.tab.frontend?.supportsBracketedPaste()
            ? '\x1b[200~' + input + '\x1b[201~' : input
    }

    private insert (text: string): void {
        this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)
        this.cursor += text.length
    }

    private previousCharacter (): number {
        return this.cursor - ([...this.buffer.slice(0, this.cursor)].pop()?.length ?? 0)
    }

    private nextCharacter (): number {
        return this.cursor + ([...this.buffer.slice(this.cursor)][0]?.length ?? 0)
    }

    private async editKey (key: string): Promise<void> {
        if (this.runtime.locked) { this.onBlockedInput(); return }
        if (!this.canCapture) { this.forwardReadline(key); return }
        // History and completion can own an empty Shell line. Once prose is
        // being edited, control sequences must never transfer it to the PTY.
        if (!this.buffer && ['\x1b[A', '\x1bOA', '\x1b[B', '\x1bOB', '\x12', '\t'].includes(key)) {
            await this.giveToReadline(key)
            return
        }
        const prefix = this.buffer.slice(0, this.cursor)
        const lineStart = prefix.lastIndexOf('\n') + 1
        const nextNewline = this.buffer.indexOf('\n', this.cursor)
        const lineEnd = nextNewline < 0 ? this.buffer.length : nextNewline
        switch (key) {
            case '\x1b[D': case '\x1bOD': case '\x02': this.cursor = this.previousCharacter(); break
            case '\x1b[C': case '\x1bOC': case '\x06': this.cursor = this.nextCharacter(); break
            case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x1b[7~': case '\x01': this.cursor = lineStart; break
            case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x1b[8~': case '\x05': this.cursor = lineEnd; break
            case '\x1b[1;5D': case '\x1bb': this.cursor = prefix.replace(/\s*\S+\s*$/, '').length; break
            case '\x1b[1;5C': case '\x1bf': this.cursor += /^\s*\S*\s*/.exec(this.buffer.slice(this.cursor))![0].length; break
            case '\x1b[A': case '\x1bOA': {
                if (lineStart) {
                    const start = this.buffer.lastIndexOf('\n', lineStart - 2) + 1
                    const column = [...prefix.slice(lineStart)].length
                    this.cursor = start + [...this.buffer.slice(start, lineStart - 1)].slice(0, column).join('').length
                }
                break
            }
            case '\x1b[B': case '\x1bOB': {
                if (nextNewline >= 0) {
                    this.cursor = nextNewline + 1 + [...this.buffer.slice(nextNewline + 1).split('\n')[0]].slice(0, [...prefix.slice(lineStart)].length).join('').length
                }
                break
            }
            case '\x1b[3~': case '\x04': this.buffer = prefix + this.buffer.slice(this.nextCharacter()); break
            case '\x0b': this.buffer = prefix + this.buffer.slice(lineEnd); break
            case '\t':
                if (this.cursor === this.buffer.length && this.detector.isShellCommand(this.buffer, this.integration.kind ?? undefined)) {
                    await this.giveToReadline(key)
                    return
                }
                this.insert('\t')
                break
            default:
                this.integration.notice.next('草稿仍保留在本地；如需 Shell 历史或补全，请先清空草稿或明确发送到 Shell')
                return
        }
        await this.paint()
    }

    private async giveToReadline (key: string): Promise<void> {
        await this.erase()
        const input = this.buffer
        this.resetInputBuffer()
        this.handedOff = true
        this.awaitingPrompt = false
        this.integration.notice.next('Shell 已接管本轮输入；新的提示符出现后恢复自动识别')
        this.sendAgent(this.remoteText(input) + key)
    }

    private forwardReadline (input: string): void {
        // Prompt repaint during history/completion is still the same editable line.
        // Only a submitted/cancelled line permits local capture at the next prompt.
        if (/[\r\n\x03]/.test(input)) {
            this.awaitingPrompt = true
            this.integration.commandStarted()
        }
        this.sendAgent(input)
    }

    private captureAnchor (): void {
        if (this.anchor) { return }
        const frontend = this.runtime.tab.frontend
        if (frontend instanceof XTermFrontend) {
            this.anchor = frontend.xterm.registerMarker(0)
            this.anchorColumn = frontend.xterm.buffer.active.cursorX
            this.anchorColumns = frontend.xterm.cols
            let line = this.anchor?.line ?? 0
            let wrapped = 0
            while (line > 0 && frontend.xterm.buffer.active.getLine(line)?.isWrapped) {
                wrapped++
                line--
            }
            this.promptCellOffset = wrapped * this.anchorColumns + this.anchorColumn
        }
    }

    private async flushTerminal (): Promise<void> {
        await this.runtime.tab.write('')
        const frontend = this.runtime.tab.frontend
        if (frontend instanceof XTermFrontend) {
            // tab.write only queues xterm input. Its Promise does not wait for
            // the parser, so buffer coordinates must use the xterm callback.
            await new Promise<void>(resolve => frontend.xterm.write('', resolve))
        }
    }

    private async erase (): Promise<void> {
        const frontend = this.runtime.tab.frontend
        if (!(frontend instanceof XTermFrontend) || !this.anchor || this.anchor.isDisposed) { return }
        await this.flushTerminal()
        const buffer = frontend.xterm.buffer.active
        let row = this.anchor.line - buffer.baseY
        if (this.anchorColumns !== frontend.xterm.cols) {
            let start = this.anchor.line
            while (start > 0 && buffer.getLine(start)?.isWrapped) { start-- }
            row = start + Math.floor(this.promptCellOffset / frontend.xterm.cols) - buffer.baseY
            this.anchorColumn = this.promptCellOffset % frontend.xterm.cols
        }
        if (row < 0) {
            await this.runtime.tab.write('\r\n' + this.integration.promptText)
            await this.flushTerminal()
            this.anchor.dispose()
            this.anchor = undefined
            this.captureAnchor()
            return
        }
        await this.runtime.tab.write('\x1b[' + (row + 1) + ';' + (this.anchorColumn + 1) + 'H\x1b[J')
    }

    private async paint (): Promise<void> {
        await this.erase()
        await this.runtime.tab.write(terminalText(this.buffer.slice(0, this.cursor)))
        const frontend = this.runtime.tab.frontend
        if (this.cursor === this.buffer.length || !(frontend instanceof XTermFrontend)) {
            await this.runtime.tab.write(terminalText(this.buffer.slice(this.cursor)))
            return
        }
        await this.flushTerminal()
        const marker = frontend.xterm.registerMarker(0)
        const column = frontend.xterm.buffer.active.cursorX
        await this.runtime.tab.write(terminalText(this.buffer.slice(this.cursor)))
        await this.flushTerminal()
        if (marker && !marker.isDisposed) {
            const row = Math.max(0, marker.line - frontend.xterm.buffer.active.baseY)
            await this.runtime.tab.write(`\x1b[${row + 1};${Math.min(column, frontend.xterm.cols - 1) + 1}H`)
        }
        marker?.dispose()
    }
}
