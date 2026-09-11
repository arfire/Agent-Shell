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
    private flushOutput = (): void => this.flush()

    constructor (
        private runtime: AISessionRuntime,
        private sessions: AISessionService,
        private redactor: SecretRedactor,
    ) {
        super()
        this.sessionId = runtime.id
        runtime.flushOutput = this.flushOutput
    }

    feedFromSession (data: Buffer): void {
        if (this.sessionId !== this.runtime.id) {
            this.outputBuffer += this.outputFilter(this.history.flush())
            this.outputBuffer += this.outputFilter.flush()
            this.flush()
            this.outputFilter = this.redactor.createScope().streamFilter(true)
            this.sessionId = this.runtime.id
        }
        // Persist complete, redacted lines so a timer cannot split a password
        // across two otherwise innocuous history events.
        this.outputBuffer += this.outputFilter(this.history.feed(this.decoder.write(data)))
        if (this.outputBuffer.length >= 262144) {
            this.flush()
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), 400)
        }
        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
        this.outputToSession.next(data)
    }

    close (): void {
        if (this.runtime.flushOutput === this.flushOutput) { this.runtime.flushOutput = undefined }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
        }
        this.outputBuffer += this.outputFilter(this.history.feed(this.decoder.end()) + this.history.flush()) + this.outputFilter.flush()
        this.flush()
        super.close()
    }

    private flush (): void {
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
