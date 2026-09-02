import { SessionMiddleware } from 'tabby-terminal'

import { AIInputDetector } from './input-detector'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'

export class AIInputMiddleware extends SessionMiddleware {
    private buffer = ''
    private decoder = new TextDecoder()
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

        for (const byte of data) {
            if (byte === 13 || byte === 10) {
                this.submit(false)
                continue
            }
            if (byte === 3 || byte === 21) {
                this.buffer = ''
                this.bufferReliable = true
                this.outputToSession.next(Buffer.from([byte]))
                continue
            }
            if (byte === 8 || byte === 127) {
                this.buffer = this.buffer.slice(0, -1)
                this.outputToSession.next(Buffer.from([byte]))
                continue
            }
            if (byte < 32) {
                this.bufferReliable = false
            }
            if (byte >= 32 || byte >= 128) {
                this.buffer += this.decoder.decode(Uint8Array.of(byte), { stream: true })
            }
            this.outputToSession.next(Buffer.from([byte]))
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

    private submit (forceAI: boolean): void {
        const input = this.buffer.trim()
        this.buffer = ''
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
}
