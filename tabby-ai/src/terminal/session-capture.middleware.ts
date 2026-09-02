import { SessionMiddleware } from 'tabby-terminal'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'

export class AISessionCaptureMiddleware extends SessionMiddleware {
    private outputBuffer = ''
    private flushTimer?: ReturnType<typeof setTimeout>

    constructor (
        private runtime: AISessionRuntime,
        private sessions: AISessionService,
    ) {
        super()
    }

    feedFromSession (data: Buffer): void {
        this.outputBuffer += data.toString('utf8')
        if (this.outputBuffer.length >= 65536) {
            this.flush()
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), 100)
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
        const content = this.outputBuffer
        this.outputBuffer = ''
        void this.sessions.append(this.runtime, 'ssh-output', { content })
    }
}
