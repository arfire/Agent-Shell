import { ApplicationRef, ComponentRef, Injectable, createComponent } from '@angular/core'
import { XTermFrontend } from 'tabby-terminal'

import { AISessionRuntime } from '../session/ai-session.service'
import { AIInlineBlockComponent } from './ai-inline-block.component'

@Injectable({ providedIn: 'root' })
export class InlineBlockService {
    private blocks = new Map<string, { sessionId: string, component: ComponentRef<AIInlineBlockComponent> }>()

    constructor (private appRef: ApplicationRef) { }

    async open (runtime: AISessionRuntime, runId: string, stopHandler?: () => void): Promise<void> {
        if (this.blocks.has(runId) || !(runtime.tab.frontend instanceof XTermFrontend)) {
            return
        }
        const host = document.createElement('div')
        const component = createComponent(AIInlineBlockComponent, {
            hostElement: host,
            environmentInjector: this.appRef.injector,
        })
        component.instance.runtime = runtime
        component.instance.runId = runId
        component.instance.stopHandler = stopHandler
        this.appRef.attachView(component.hostView)
        component.changeDetectorRef.detectChanges()
        const decoration = await runtime.tab.frontend.registerInlineBlock(host, 12)
        if (!decoration) {
            this.appRef.detachView(component.hostView)
            component.destroy()
            return
        }
        component.onDestroy(() => decoration.dispose())
        this.blocks.set(runId, { sessionId: runtime.id, component })
    }

    detachSession (sessionId: string): void {
        for (const [runId, block] of this.blocks) {
            if (block.sessionId !== sessionId) {
                continue
            }
            this.appRef.detachView(block.component.hostView)
            block.component.destroy()
            this.blocks.delete(runId)
        }
    }
}
