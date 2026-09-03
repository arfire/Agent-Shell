import { SessionMiddleware } from 'tabby-terminal'
import { StringDecoder } from 'string_decoder'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { SecretRedactor } from '../policy/secret-redactor'

export class AISessionCaptureMiddleware extends SessionMiddleware {
    private outputBuffer = ''
    private flushTimer?: ReturnType<typeof setTimeout>
    private decoder = new StringDecoder('utf8')

    constructor (
        private runtime: AISessionRuntime,
        private sessions: AISessionService,
        private redactor: SecretRedactor,
    ) {
        super()
    }

    feedFromSession (data: Buffer): void {
        this.outputBuffer += this.decoder.write(data)
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
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
        }
        this.outputBuffer += this.decoder.end()
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
        void this.sessions.append(this.runtime, 'ssh-output', { content })
    }
}
