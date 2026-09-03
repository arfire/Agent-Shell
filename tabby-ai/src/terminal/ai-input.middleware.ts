import { SessionMiddleware } from 'tabby-terminal'
import { StringDecoder } from 'string_decoder'

import { AIInputDetector } from './input-detector'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'

export class AIInputMiddleware extends SessionMiddleware {
    private buffer: string[] = []
    private cursor = 0
    private decoder = new StringDecoder('utf8')
    private escapeSequence = ''
    private bracketedPaste = false
    private ignoreNextLineFeed = false
    private bufferReliable = true

    constructor (
        private runtime: AISessionRuntime,
        private sessions: AISessionService,
        private detector: AIInputDetector,
        private onAIRequest: (input: string) => void,
        private onBlockedInput: () => void,
    ) {
        super()
    }

    feedFromSession (data: Buffer): void {
        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
        if (this.runtime.locked) {
            if (data.length === 1 && data[0] === 3) {
                this.outputToSession.next(data)
            } else {
                this.onBlockedInput()
            }
            return
        }

        for (const character of this.decoder.write(data)) {
            this.processCharacter(character)
        }
    }

    forceAI (): void {
        if (this.runtime.locked) {
            this.onBlockedInput()
            return
        }
        this.submit(true)
    }

    sendAgent (data: string|Buffer): void {
        this.outputToSession.next(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
    }

    resetInputBuffer (): void {
        this.resetBuffer()
        this.escapeSequence = ''
        this.bracketedPaste = false
        this.ignoreNextLineFeed = false
    }

    close (): void {
        this.decoder.end()
        super.close()
    }

    private submit (forceAI: boolean): void {
        const input = this.buffer.join('').trim()
        this.buffer = []
        this.cursor = 0
        const reliable = this.bufferReliable
        this.bufferReliable = true
        if (!input) {
            this.outputToSession.next(Buffer.from('\r'))
            return
        }
        if (!forceAI && (!reliable || this.detector.isShellCommand(input))) {
            if (reliable) {
                void this.sessions.append(this.runtime, 'ssh-input', { content: input, source: 'user' })
            }
            this.outputToSession.next(Buffer.from('\r'))
            return
        }

        // The line has already been echoed by the remote readline implementation.
        // Ctrl+U removes it without submitting it to the shell.
        this.outputToSession.next(Buffer.from('\x15'))
        this.onAIRequest(input)
    }

    private processCharacter (character: string): void {
        if (this.escapeSequence) {
            this.escapeSequence += character
            if (this.isCompleteEscapeSequence(this.escapeSequence)) {
                const sequence = this.escapeSequence
                this.escapeSequence = ''
                this.handleEscapeSequence(sequence)
                this.sendAgent(sequence)
            } else if (this.escapeSequence.length > 32) {
                this.bufferReliable = false
                this.sendAgent(this.escapeSequence)
                this.escapeSequence = ''
            }
            return
        }
        if (character === '\x1b') {
            this.escapeSequence = character
            return
        }
        if (character === '\n' && this.ignoreNextLineFeed) {
            this.ignoreNextLineFeed = false
            return
        }
        this.ignoreNextLineFeed = false
        if ((character === '\r' || character === '\n') && !this.bracketedPaste) {
            this.ignoreNextLineFeed = character === '\r'
            this.submit(false)
            return
        }
        if (this.bracketedPaste && (character === '\r' || character === '\n')) {
            this.insert('\n')
            this.sendAgent(character)
            return
        }
        if (character === '\x03') {
            this.resetBuffer()
            this.sendAgent(character)
            return
        }
        if (character === '\x01') {
            this.cursor = 0
            this.sendAgent(character)
            return
        }
        if (character === '\x05') {
            this.cursor = this.buffer.length
            this.sendAgent(character)
            return
        }
        if (character === '\x0b') {
            this.buffer.splice(this.cursor)
            this.sendAgent(character)
            return
        }
        if (character === '\x15') {
            this.buffer.splice(0, this.cursor)
            this.cursor = 0
            if (!this.buffer.length) {
                this.bufferReliable = true
            }
            this.sendAgent(character)
            return
        }
        if (character === '\x17') {
            this.deletePreviousWord()
            this.sendAgent(character)
            return
        }
        if (character === '\x08' || character === '\x7f') {
            if (this.cursor > 0) {
                this.buffer.splice(--this.cursor, 1)
            }
            this.sendAgent(character)
            return
        }
        if (character.codePointAt(0)! < 32) {
            this.bufferReliable = false
            this.sendAgent(character)
            return
        }
        this.insert(character)
        this.sendAgent(character)
    }

    private insert (value: string): void {
        const characters = [...value]
        this.buffer.splice(this.cursor, 0, ...characters)
        this.cursor += characters.length
    }

    private deletePreviousWord (): void {
        while (this.cursor > 0 && /\s/.test(this.buffer[this.cursor - 1])) {
            this.buffer.splice(--this.cursor, 1)
        }
        while (this.cursor > 0 && !/\s/.test(this.buffer[this.cursor - 1])) {
            this.buffer.splice(--this.cursor, 1)
        }
    }

    private resetBuffer (): void {
        this.buffer = []
        this.cursor = 0
        this.bufferReliable = true
    }

    private isCompleteEscapeSequence (sequence: string): boolean {
        if (sequence.length < 2) {
            return false
        }
        if (sequence[1] === '[') {
            if (sequence.length < 3) {
                return false
            }
            const last = sequence[sequence.length - 1]
            return last >= '@' && last <= '~'
        }
        if (sequence[1] === 'O') {
            return sequence.length >= 3
        }
        return true
    }

    private handleEscapeSequence (sequence: string): void {
        if (sequence === '\x1b[200~') {
            this.bracketedPaste = true
            return
        }
        if (sequence === '\x1b[201~') {
            this.bracketedPaste = false
            return
        }
        if (['\x1b[D', '\x1bOD'].includes(sequence)) {
            this.cursor = Math.max(0, this.cursor - 1)
            return
        }
        if (['\x1b[C', '\x1bOC'].includes(sequence)) {
            this.cursor = Math.min(this.buffer.length, this.cursor + 1)
            return
        }
        if (['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~'].includes(sequence)) {
            this.cursor = 0
            return
        }
        if (['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~'].includes(sequence)) {
            this.cursor = this.buffer.length
            return
        }
        if (sequence === '\x1b[3~') {
            if (this.cursor < this.buffer.length) {
                this.buffer.splice(this.cursor, 1)
            }
            return
        }
        // History navigation, completion and unknown terminal sequences can
        // replace the remote readline buffer with text we cannot observe.
        this.bufferReliable = false
    }
}
