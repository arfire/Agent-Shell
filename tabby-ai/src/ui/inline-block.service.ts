import { ApplicationRef, ComponentRef, Injectable, createComponent } from '@angular/core'
import { XTermFrontend, type InlineBlockDecoration } from 'tabby-terminal'

import { AISessionRuntime } from '../session/ai-session.service'
import { AIInlineBlockComponent } from './ai-inline-block.component'

interface InlineBlockRecord {
    sessionId: string
    runId: string
    component: ComponentRef<AIInlineBlockComponent>
    decoration: InlineBlockDecoration
}

@Injectable({ providedIn: 'root' })
export class InlineBlockService {
    private activeBlocks = new Map<string, InlineBlockRecord>()
    private blocks = new Set<InlineBlockRecord>()

    constructor (private appRef: ApplicationRef) { }

    async open (
        runtime: AISessionRuntime,
        runId: string,
        stopHandler?: () => void,
        firstEventSeq = 0,
    ): Promise<void> {
        if (this.activeBlocks.has(runId) || !(runtime.tab.frontend instanceof XTermFrontend)) {
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
        component.instance.firstEventSeq = firstEventSeq
        this.appRef.attachView(component.hostView)
        component.changeDetectorRef.detectChanges()
        const decoration = await runtime.tab.frontend.registerInlineBlock(host, 6, 32)
        if (!decoration) {
            this.appRef.detachView(component.hostView)
            component.destroy()
            return
        }
        component.instance.preferredHeightHandler = (height, userInitiated) => decoration.resizeToContent(height, userInitiated)
        component.instance.refreshLayout()
        component.onDestroy(() => decoration.dispose())
        const block = { sessionId: runtime.id, runId, component, decoration }
        this.blocks.add(block)
        this.activeBlocks.set(runId, block)
    }

    async interrupt (runId: string): Promise<void> {
        const block = this.activeBlocks.get(runId)
        if (!block) {
            return
        }
        this.activeBlocks.delete(runId)
        block.component.instance.interrupt()
        block.component.changeDetectorRef.detectChanges()
        block.component.instance.refreshLayout(true)
        await block.decoration.lock()
    }

    async finish (runId: string): Promise<void> {
        const block = this.activeBlocks.get(runId)
        if (!block) {
            return
        }
        this.activeBlocks.delete(runId)
        block.component.instance.finish()
        block.component.changeDetectorRef.detectChanges()
        block.component.instance.refreshLayout(true)
        await block.decoration.lock()
    }

    detachSession (sessionId: string): void {
        for (const block of [...this.blocks]) {
            if (block.sessionId !== sessionId) {
                continue
            }
            if (this.activeBlocks.get(block.runId) === block) {
                this.activeBlocks.delete(block.runId)
            }
            this.blocks.delete(block)
            this.appRef.detachView(block.component.hostView)
            block.component.destroy()
        }
    }
}
