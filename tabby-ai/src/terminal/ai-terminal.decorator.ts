import { Injectable } from '@angular/core'
import { SSHTabComponent } from 'tabby-ssh'
import { BaseTerminalTabComponent, SessionMiddlewareStack, TerminalDecorator, XTermFrontend } from 'tabby-terminal'

import { AISessionService } from '../session/ai-session.service'
import { AgentService } from '../agent/agent.service'
import { AIInputMiddleware } from './ai-input.middleware'
import { AISessionCaptureMiddleware } from './session-capture.middleware'
import { TerminalControllerService } from './terminal-controller.service'
import { InlineBlockService } from '../ui/inline-block.service'
import { SecretRedactor } from '../policy/secret-redactor'

@Injectable()
export class AITerminalDecorator extends TerminalDecorator {
    private attachedMiddlewareStacks = new WeakSet<SessionMiddlewareStack>()

    constructor (
        private sessions: AISessionService,
        private controller: TerminalControllerService,
        private blocks: InlineBlockService,
        private agent: AgentService,
        private redactor: SecretRedactor,
    ) {
        super()
    }

    attach (terminal: BaseTerminalTabComponent<any>): void {
        if (!(terminal instanceof SSHTabComponent) || !(terminal.frontend instanceof XTermFrontend)) {
            return
        }
        void this.attachRuntime(terminal)
        this.subscribeUntilDetached(terminal, terminal.sessionChanged$.subscribe(() => {
            void this.attachMiddleware(terminal)
        }))
    }

    detach (terminal: BaseTerminalTabComponent<any>): void {
        if (terminal instanceof SSHTabComponent) {
            const runtime = this.sessions.get(terminal)
            if (runtime) {
                this.blocks.detachSession(runtime.id)
            }
            this.controller.detach(terminal)
            this.sessions.detach(terminal)
        }
        super.detach(terminal)
    }

    private async attachRuntime (tab: SSHTabComponent): Promise<void> {
        const runtime = await this.sessions.attach(tab)
        await this.attachMiddleware(tab)
        await this.controller.attach(tab, runtime, this.getRequestHandler(runtime))
        // JSONL history remains available to the context builder. Recreating
        // every historical Angular decoration at the current cursor would
        // duplicate old blocks and make each xterm repaint progressively
        // slower after reconnecting.
    }

    private async attachMiddleware (tab: SSHTabComponent): Promise<void> {
        if (!tab.session) {
            return
        }
        const runtime = await this.sessions.attach(tab)
        if (!this.attachedMiddlewareStacks.has(tab.session.middleware)) {
            tab.session.middleware.unshift(new AISessionCaptureMiddleware(runtime, this.sessions, this.redactor))
            this.attachedMiddlewareStacks.add(tab.session.middleware)
        }
        await this.controller.attachMiddleware(tab, runtime, this.getRequestHandler(runtime))
    }

    private getRequestHandler (runtime: Awaited<ReturnType<AISessionService['attach']>>) {
        return (input: string, middleware: AIInputMiddleware) => {
            void this.agent.start(runtime, input, middleware)
        }
    }
}
