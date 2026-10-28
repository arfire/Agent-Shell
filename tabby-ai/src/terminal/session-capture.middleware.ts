import { SessionMiddleware } from 'tabby-terminal'
import { StringDecoder } from 'string_decoder'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { SecretRedactor } from '../policy/secret-redactor'
import { TerminalHistoryFilter } from './terminal-history-filter'

export class AISessionCaptureMiddleware extends SessionMiddleware {
    private outputBuffer = ''
    private flushTimer?: ReturnType<typeof setTimeout>
    private decoder = new StringDecoder('utf8')
    private history = new TerminalHistoryFilter()
    private outputFilter = this.redactor.createScope().streamFilter(true)
    private sessionId: string
    private queuedSessionId: string
    private flushOutput = (): Promise<void> => this.flush()
    private pendingCapture: (Buffer|(() => void))[] = []
    private captureTimer?: ReturnType<typeof setTimeout>

    constructor (
        private runtime: AISessionRuntime,
        private sessions: AISessionService,
        private redactor: SecretRedactor,
    ) {
        super()
        this.sessionId = runtime.id
        this.queuedSessionId = runtime.id
        runtime.flushOutput = this.flushOutput
    }

    feedFromSession (data: Buffer): void {
        const sessionId = this.runtime.id
        // The terminal is the live stream. History parsing/redaction must not
        // delay forwarding an SSH packet or redraw the user's terminal.
        this.outputToTerminal.next(data)
        if (this.queuedSessionId !== sessionId) {
            this.pendingCapture.push(() => {
                this.outputBuffer += this.outputFilter(this.history.feed(this.decoder.end()) + this.history.flush())
                this.outputBuffer += this.outputFilter.flush()
                this.saveOutput()
                this.decoder = new StringDecoder('utf8')
                this.outputFilter = this.redactor.createScope().streamFilter(true)
                this.sessionId = sessionId
            })
            this.queuedSessionId = sessionId
        }
        this.pendingCapture.push(data)
        this.scheduleCapture()
    }

    private scheduleCapture (): void {
        if (this.captureTimer !== undefined || !this.pendingCapture.length) { return }
        this.captureTimer = setTimeout(() => {
            this.captureTimer = undefined
            // Bound each history slice so sustained output leaves time for
            // keyboard events and xterm rendering between batches.
            this.capturePending(8192)
            this.scheduleCapture()
        }, 0)
    }

    private capturePending (limit = Infinity): void {
        if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = undefined }
        const chunks: Buffer[] = []
        let size = 0
        while (this.pendingCapture.length && size < limit) {
            const chunk = this.pendingCapture[0]
            if (typeof chunk === 'function') { break }
            const length = Math.min(chunk.length, limit - size)
            chunks.push(chunk.subarray(0, length))
            size += length
            if (length === chunk.length) { this.pendingCapture.shift() } else { this.pendingCapture[0] = chunk.subarray(length) }
        }
        // Persist complete, redacted lines so a timer cannot split a password
        // across two otherwise innocuous history events.
        if (chunks.length) {
            this.outputBuffer += this.outputFilter(this.history.feed(this.decoder.write(Buffer.concat(chunks))))
        }
        if (this.outputBuffer.length >= 16384) {
            this.saveOutput()
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.saveOutput(), 400)
        }
        if (typeof this.pendingCapture[0] === 'function') {
            const boundary = this.pendingCapture.shift() as () => void
            boundary()
            // Promise continuations append command events before the next batch.
        }
    }

    feedFromTerminal (data: Buffer): void {
        this.outputToSession.next(data)
    }

    close (): void {
        if (this.runtime.flushOutput === this.flushOutput) { this.runtime.flushOutput = undefined }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
        }
        while (this.pendingCapture.length) { this.capturePending() }
        this.outputBuffer += this.outputFilter(this.history.feed(this.decoder.end()) + this.history.flush()) + this.outputFilter.flush()
        this.saveOutput()
        super.close()
    }

    private flush (): Promise<void> {
        if (!this.pendingCapture.length) { this.saveOutput(); return Promise.resolve() }
        return new Promise(resolve => {
            this.pendingCapture.push(() => { this.saveOutput(); resolve() })
            this.scheduleCapture()
        })
    }

    private saveOutput (): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
            this.flushTimer = undefined
        }
        if (!this.outputBuffer) {
            return
        }
        const content = this.redactor.redact(this.outputBuffer)
        this.outputBuffer = ''
        void this.sessions.appendToContext(this.runtime, this.sessionId, 'ssh-output', { content })
    }
}
