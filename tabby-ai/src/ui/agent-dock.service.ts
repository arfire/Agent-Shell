import { ApplicationRef, ComponentRef, Injectable, createComponent } from '@angular/core'

import { AISessionRuntime } from '../session/ai-session.service'
import { AgentDockComponent } from './agent-dock.component'

@Injectable({ providedIn: 'root' })
export class AgentDockService {
    private docks = new Map<AISessionRuntime['tab'], ComponentRef<AgentDockComponent>>()

    constructor (private app: ApplicationRef) { }

    attach (runtime: AISessionRuntime): void {
        if (this.docks.has(runtime.tab)) { return }
        const host = document.createElement('ash-agent-dock')
        const component = createComponent(AgentDockComponent, { hostElement: host, environmentInjector: this.app.injector })
        component.instance.runtime = runtime
        runtime.tab.element.nativeElement.appendChild(host)
        this.app.attachView(component.hostView)
        component.changeDetectorRef.detectChanges()
        component.onDestroy(() => host.remove())
        this.docks.set(runtime.tab, component)
    }

    detach (tab: AISessionRuntime['tab']): void {
        const component = this.docks.get(tab)
        if (component) {
            this.docks.delete(tab)
            this.app.detachView(component.hostView)
            component.destroy()
        }
    }
}
