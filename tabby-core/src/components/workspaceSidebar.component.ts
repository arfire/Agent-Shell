import { Component, ComponentRef, HostListener, Inject, Input, OnDestroy, OnInit, Optional, ViewChild, ViewContainerRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { WorkspacePanelProvider } from '../api/workspacePanel'
import { WorkspacePanelService } from '../services/workspacePanel.service'
import { AppService } from '../services/app.service'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'

@Component({
    selector: 'workspace-sidebar',
    templateUrl: './workspaceSidebar.component.pug',
    styleUrls: ['./workspaceSidebar.component.scss'],
})
export class WorkspaceSidebarComponent implements OnInit, OnDestroy {
    @Input() macInset = false
    @ViewChild('panel', { read: ViewContainerRef, 'static': true }) panel: ViewContainerRef
    selected = window.localStorage.ashSidebarPanel || 'servers'
    collapsed = window.localStorage.ashSidebarCollapsed === 'true'
    width = Math.max(240, Math.min(560, Number(window.localStorage.ashSidebarWidth) || 300))
    private subscriptions = new Subscription()
    private focusSubscription?: Subscription
    private content?: ComponentRef<unknown>
    private tab: BaseTabComponent|null = null
    private followedTab?: BaseTabComponent|null
    private drag?: { x: number, width: number }
    private resizeTimer?: ReturnType<typeof setTimeout>
    private nextWidth = this.width

    constructor (
        private app: AppService,
        service: WorkspacePanelService,
        @Optional() @Inject(WorkspacePanelProvider) public providers: WorkspacePanelProvider[]|null,
    ) {
        this.subscriptions.add(service.requested.subscribe(id => this.select(id)))
    }

    ngOnInit (): void {
        if (this.selected !== 'servers' && !this.providers?.some(x => x.id === this.selected)) { this.selected = 'servers' }
        this.subscriptions.add(this.app.activeTabChange$.subscribe(tab => this.follow(tab)))
        this.follow(this.app.activeTab)
        queueMicrotask(() => this.render())
    }

    select (id: string): void {
        const changed = this.selected !== id
        this.selected = id
        this.collapsed = false
        this.save()
        if (changed) { this.render() }
    }

    toggle (): void {
        this.collapsed = !this.collapsed
        this.save()
    }

    private save (): void {
        window.localStorage.ashSidebarPanel = this.selected
        window.localStorage.ashSidebarCollapsed = String(this.collapsed)
    }

    private follow (tab: BaseTabComponent|null): void {
        if (this.followedTab === tab) { return }
        this.followedTab = tab
        this.focusSubscription?.unsubscribe()
        if (tab instanceof SplitTabComponent) {
            this.focusSubscription = tab.focusChanged$.subscribe(child => this.setTab(child))
            this.setTab(tab.getFocusedTab())
        } else { this.setTab(tab) }
    }

    private setTab (tab: BaseTabComponent|null): void {
        if (this.tab === tab) { return }
        this.tab = tab
        this.content?.setInput('tab', tab)
    }

    private render (): void {
        this.panel.clear()
        this.content = undefined
        const provider = this.providers?.find(x => x.id === this.selected)
        if (provider) {
            this.content = this.panel.createComponent(provider.component)
            this.content.setInput('tab', this.tab)
        }
    }

    startResize (event: MouseEvent): void {
        this.drag = { x: event.clientX, width: this.width }
        this.nextWidth = this.width
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    resize (event: MouseEvent): void {
        if (!this.drag) { return }
        this.nextWidth = Math.max(240, Math.min(560, window.innerWidth - 360, this.drag.width + event.clientX - this.drag.x))
        if (this.resizeTimer !== undefined) { return }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = undefined
            this.width = this.nextWidth
        }, 80)
    }

    @HostListener('document:mouseup')
    endResize (): void {
        if (!this.drag) { return }
        clearTimeout(this.resizeTimer)
        this.resizeTimer = undefined
        this.width = this.nextWidth
        this.drag = undefined
        window.localStorage.ashSidebarWidth = String(this.width)
    }

    ngOnDestroy (): void {
        clearTimeout(this.resizeTimer)
        this.focusSubscription?.unsubscribe()
        this.subscriptions.unsubscribe()
    }
}
