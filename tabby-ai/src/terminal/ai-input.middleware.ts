import { SessionMiddleware } from 'tabby-terminal'
import { StringDecoder } from 'string_decoder'

import { AIInputDetector } from './input-detector'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { detectInteractivePrompt, looksLikeShellPrompt } from './interactive-prompt'

interface TerminalInputAction {
    output?: string
    aiInput?: string
}

export class AIInputMiddleware extends SessionMiddleware {
    private buffer: string[] = []
    private cursor = 0
    private decoder = new StringDecoder('utf8')
    private sessionDecoder = new StringDecoder('utf8')
    private recentSessionOutput = ''
    private interactiveInputExpected = false
    private pendingAIInput?: string
    private pendingAIStartTimer?: ReturnType<typeof setTimeout>
    private escapeSequence = ''
    private bracketedPaste = false
    private bracketedPasteContent = ''
    private bracketedPasteStartedWithInput = false
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
        this.recentSessionOutput = `${this.recentSessionOutput}${this.sessionDecoder.write(data)}`.slice(-1200)
        if (detectInteractivePrompt(this.recentSessionOutput)) {
            this.interactiveInputExpected = true
        } else if (looksLikeShellPrompt(this.recentSessionOutput)) {
            this.interactiveInputExpected = false
        }
        this.outputToTerminal.next(data)
        if (this.pendingAIInput && looksLikeShellPrompt(this.recentSessionOutput)) {
            this.startPendingAIRequest()
        }
    }

    feedFromTerminal (data: Buffer): void {
        if (this.pendingAIInput) {
            if (data.length === 1 && data[0] === 3) {
                this.pendingAIInput = undefined
                if (this.pendingAIStartTimer) {
                    clearTimeout(this.pendingAIStartTimer)
                    this.pendingAIStartTimer = undefined
                }
                this.sendAgent(data)
            } else {
                this.onBlockedInput()
            }
            return
        }
        if (this.runtime.locked) {
            if (data.length === 1 && data[0] === 3) {
                this.outputToSession.next(data)
            } else {
                this.onBlockedInput()
            }
            return
        }

        // xterm emits one committed IME composition as a single chunk. Keep
        // that chunk intact on the session side: splitting it into individual
        // Unicode characters creates one SSH write per character, which adds
        // latency and can interleave Chinese input with remote echo updates.
        let output = ''
        const flush = (): void => {
            if (output) {
                this.sendAgent(output)
                output = ''
            }
        }
        const characters = [...this.decoder.write(data)]
        for (let index = 0; index < characters.length; index++) {
            const character = characters[index]
            const action = this.processCharacter(character)
            output += action.output ?? ''
            if (action.aiInput !== undefined) {
                // Without bracketed-paste mode, xterm can deliver an entire
                // multiline clipboard payload in one chunk. Once its first
                // line is recognized as an AI request, the remaining lines
                // must join that request instead of falling through to Bash.
                const trailingInput = this.normalizeTrailingAIInput(characters.slice(index + 1).join(''))
                flush()
                this.ignoreNextLineFeed = false
                this.escapeSequence = ''
                this.bracketedPaste = false
                this.bracketedPasteContent = ''
                this.queueAIRequest(trailingInput ? `${action.aiInput}\n${trailingInput}` : action.aiInput)
                return
            }
        }
        flush()
    }

    forceAI (): void {
        if (this.runtime.locked) {
            this.onBlockedInput()
            return
        }
        const action = this.submit(true)
        if (action.output) {
            this.sendAgent(action.output)
        }
        if (action.aiInput !== undefined) {
            this.queueAIRequest(action.aiInput)
        }
    }

    sendAgent (data: string|Buffer): void {
        this.outputToSession.next(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
    }

    resetInputBuffer (): void {
        this.resetBuffer()
        this.escapeSequence = ''
        this.bracketedPaste = false
        this.bracketedPasteContent = ''
        this.bracketedPasteStartedWithInput = false
        this.ignoreNextLineFeed = false
    }

    close (): void {
        if (this.pendingAIStartTimer) {
            clearTimeout(this.pendingAIStartTimer)
        }
        this.decoder.end()
        this.sessionDecoder.end()
        super.close()
    }

    private submit (forceAI: boolean): TerminalInputAction {
        const input = this.buffer.join('').trim()
        this.buffer = []
        this.cursor = 0
        const reliable = this.bufferReliable
        this.bufferReliable = true
        if (!input) {
            return { output: '\r' }
        }
        if (!forceAI && this.interactiveInputExpected) {
            this.interactiveInputExpected = false
            void this.sessions.append(this.runtime, 'ssh-input', {
                content: '[INTERACTIVE_INPUT_SENT_DIRECTLY_TO_PROGRAM]',
                source: 'user',
            })
            return { output: '\r' }
        }
        if (!forceAI && (!reliable || this.detector.isShellCommand(input))) {
            if (reliable) {
                void this.sessions.append(this.runtime, 'ssh-input', { content: input, source: 'user' })
            }
            return { output: '\r' }
        }

        // The line has already been echoed by the remote readline implementation.
        // Ctrl+U removes it without submitting it to the shell.
        return { output: '\x15', aiInput: input }
    }

    private processCharacter (character: string): TerminalInputAction {
        if (this.escapeSequence) {
            this.escapeSequence += character
            if (this.isCompleteEscapeSequence(this.escapeSequence)) {
                const sequence = this.escapeSequence
                this.escapeSequence = ''
                if (sequence === '\x1b[200~') {
                    this.bracketedPaste = true
                    this.bracketedPasteContent = ''
                    this.bracketedPasteStartedWithInput = this.buffer.length > 0
                    return {}
                }
                if (this.bracketedPaste) {
                    if (sequence === '\x1b[201~') {
                        return this.finishBracketedPaste()
                    }
                    this.bracketedPasteContent += sequence
                    return {}
                }
                this.handleEscapeSequence(sequence)
                return { output: sequence }
            } else if (this.escapeSequence.length > 32) {
                this.bufferReliable = false
                const sequence = this.escapeSequence
                this.escapeSequence = ''
                return { output: sequence }
            }
            return {}
        }
        if (character === '\x1b') {
            this.escapeSequence = character
            return {}
        }
        if (this.bracketedPaste) {
            this.bracketedPasteContent += character
            return {}
        }
        if (character === '\n' && this.ignoreNextLineFeed) {
            this.ignoreNextLineFeed = false
            return {}
        }
        this.ignoreNextLineFeed = false
        if (character === '\r' || character === '\n') {
            this.ignoreNextLineFeed = character === '\r'
            return this.submit(false)
        }
        if (character === '\x03') {
            this.resetBuffer()
            return { output: character }
        }
        if (character === '\x01') {
            this.cursor = 0
            return { output: character }
        }
        if (character === '\x05') {
            this.cursor = this.buffer.length
            return { output: character }
        }
        if (character === '\x0b') {
            this.buffer.splice(this.cursor)
            return { output: character }
        }
        if (character === '\x15') {
            this.buffer.splice(0, this.cursor)
            this.cursor = 0
            if (!this.buffer.length) {
                this.bufferReliable = true
            }
            return { output: character }
        }
        if (character === '\x17') {
            this.deletePreviousWord()
            return { output: character }
        }
        if (character === '\x08' || character === '\x7f') {
            if (this.cursor > 0) {
                this.buffer.splice(--this.cursor, 1)
            }
            return { output: character }
        }
        if (character.codePointAt(0)! < 32) {
            this.bufferReliable = false
            return { output: character }
        }
        this.insert(character)
        return { output: character }
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

    private finishBracketedPaste (): TerminalInputAction {
        const content = this.bracketedPasteContent
        const startedWithInput = this.bracketedPasteStartedWithInput
        this.bracketedPaste = false
        this.bracketedPasteContent = ''
        this.bracketedPasteStartedWithInput = false

        const normalized = content.replace(/\r\n?/g, '\n')
        this.insert(normalized)
        const input = this.buffer.join('').trim()
        if (normalized.includes('\n') && input && !this.detector.isShellCommand(input)) {
            this.resetBuffer()
            // Nothing from this paste reached the PTY. Only clear text that
            // was already typed before the paste; an empty prompt needs no
            // remote editing sequence at all.
            return {
                output: startedWithInput ? '\x15' : undefined,
                aiInput: input,
            }
        }

        return { output: `\x1b[200~${content}\x1b[201~` }
    }

    private normalizeTrailingAIInput (value: string): string {
        return value
            .replace(/\x1b\[20[01]~/g, '')
            .replace(/\r\n?/g, '\n')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
            .trim()
    }

    private queueAIRequest (input: string): void {
        this.pendingAIInput = input
        if (this.pendingAIStartTimer) {
            clearTimeout(this.pendingAIStartTimer)
        }
        // Ctrl+U is processed by the remote readline implementation. Wait for
        // its prompt redraw before reserving xterm rows, otherwise that redraw
        // races the local AI decoration and leaves duplicated input below it.
        this.pendingAIStartTimer = setTimeout(() => this.startPendingAIRequest(), 1000)
    }

    private startPendingAIRequest (): void {
        const input = this.pendingAIInput
        if (!input) {
            return
        }
        this.pendingAIInput = undefined
        if (this.pendingAIStartTimer) {
            clearTimeout(this.pendingAIStartTimer)
            this.pendingAIStartTimer = undefined
        }
        setTimeout(() => this.onAIRequest(input))
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
