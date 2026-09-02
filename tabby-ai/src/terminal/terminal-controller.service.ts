import { Injectable } from '@angular/core'
import { ToastrService } from 'ngx-toastr'
import { SSHTabComponent } from 'tabby-ssh'
import { SessionMiddlewareStack, XTermFrontend } from 'tabby-terminal'

import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { AIInputDetector } from './input-detector'
import { AIInputMiddleware } from './ai-input.middleware'
import { CommandExecutionResult, CommandFramingMiddleware, InteractivePromptKind } from './command-framing.middleware'

export type AIRequestHandler = (input: string, middleware: AIInputMiddleware) => void

@Injectable({ providedIn: 'root' })
export class TerminalControllerService {
    private middlewareByTab = new Map<SSHTabComponent, AIInputMiddleware>()
    private framingByTab = new Map<SSHTabComponent, CommandFramingMiddleware>()
    private attachedStacks = new WeakSet<SessionMiddlewareStack>()

    constructor (
        private sessions: AISessionService,
        private detector: AIInputDetector,
        private toastr: ToastrService,
    ) { }

    async attach (tab: SSHTabComponent, runtime: AISessionRuntime, onAIRequest: AIRequestHandler): Promise<void> {
        await this.attachMiddleware(tab, runtime, onAIRequest)
        if (tab.frontend instanceof XTermFrontend) {
            tab.frontend.keyEvent$.subscribe(event => {
                if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
                    event.preventDefault()
                    event.stopPropagation()
                    this.middlewareByTab.get(tab)?.forceAI()
                }
            })
        }
    }

    async attachMiddleware (
        tab: SSHTabComponent,
        runtime: AISessionRuntime,
        onAIRequest: AIRequestHandler,
    ): Promise<void> {
        if (!tab.session || this.attachedStacks.has(tab.session.middleware)) {
            return
        }
        const middleware = new AIInputMiddleware(
            runtime,
            this.sessions,
            this.detector,
            input => onAIRequest(input, middleware),
            () => this.toastr.warning('AI is operating this SSH terminal.', 'Terminal input locked'),
        )
        tab.session.middleware.unshift(middleware)
        const framing = new CommandFramingMiddleware()
        tab.session.middleware.unshift(framing)
        this.middlewareByTab.set(tab, middleware)
        this.framingByTab.set(tab, framing)
        this.attachedStacks.add(tab.session.middleware)
    }

    detach (tab: SSHTabComponent): void {
        this.middlewareByTab.delete(tab)
        this.framingByTab.delete(tab)
    }

    async execute (
        runtime: AISessionRuntime,
        command: string,
        onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>,
    ): Promise<CommandExecutionResult> {
        const input = this.middlewareByTab.get(runtime.tab)
        const framing = this.framingByTab.get(runtime.tab)
        if (!input || !framing) {
            throw new Error('AI terminal middleware is not attached')
        }
        return framing.execute(command, input, onPrompt)
    }
}
