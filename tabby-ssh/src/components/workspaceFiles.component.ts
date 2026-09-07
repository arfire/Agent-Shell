import { Component, Injectable, Input, OnDestroy, ViewChild } from '@angular/core'
import { BaseTabComponent, WorkspacePanelProvider } from 'tabby-core'
import { Subscription } from 'rxjs'
import { SSHTabComponent } from './sshTab.component'
import { SFTPPanelComponent } from './sftpPanel.component'

@Component({
    selector: 'workspace-files',
    template: `
        <div class="p-2" *ngIf="sshTab as ssh">
            <div class="text-break mb-2">{{ssh.profile.options.user}}@{{ssh.profile.options.host}}:{{ssh.profile.options.port || 22}}</div>
            <label><input type="checkbox" [ngModel]="followDirectory" (ngModelChange)="setFollow($event)"> 跟随终端目录</label>
            <button class="btn btn-sm btn-link" (click)="jump()" [disabled]="!directory">跳转到终端目录</button>
            <small class="d-block text-muted" *ngIf="!directory">等待 Shell 上报工作目录</small>
        </div>
        <sftp-panel *ngFor="let connection of connections" [session]="connection.session" [path]="connection.tab.sftpPath"
            (pathChange)="connection.tab.sftpPath = $event" [cwdDetectionAvailable]="!!directory" [embedded]="true"></sftp-panel>
        <p class="p-3 text-muted" *ngIf="!connectedTab">请选择已连接的 SSH 终端以浏览文件。</p>
    `,
    styles: [`
        :host { display: flex; flex: 1; min-height: 0; flex-direction: column; }
        sftp-panel { flex: 1; min-height: 0; }
    `],
})
export class WorkspaceFilesComponent implements OnDestroy {
    @ViewChild(SFTPPanelComponent) panel?: SFTPPanelComponent
    sshTab: SSHTabComponent|null = null
    connectedTab: SSHTabComponent|null = null
    connections: { tab: SSHTabComponent, session: NonNullable<SSHTabComponent['sshSession']> }[] = []
    directory: string|null = null
    followDirectory = window.localStorage.ashFollowDirectory === 'true'
    private subscriptions = new Subscription()
    private timer?: ReturnType<typeof setInterval>
    private generation = 0
    private following = false

    @Input() set tab (tab: BaseTabComponent|null) {
        const sshTab = tab instanceof SSHTabComponent ? tab : null
        if (this.sshTab === sshTab) { return }
        this.subscriptions.unsubscribe()
        this.subscriptions = new Subscription()
        this.generation++
        clearInterval(this.timer)
        this.connectedTab = null
        this.connections = []
        this.directory = null
        this.sshTab = sshTab
        if (this.sshTab) {
            this.subscriptions.add(this.sshTab.sessionChanged$.subscribe(() => {
                this.connectedTab = null
                this.connections = []
                this.directory = null
            }))
            this.timer = setInterval(() => { void this.refresh() }, 500)
            void this.refresh()
        }
    }

    async refresh (): Promise<void> {
        const tab = this.sshTab
        const generation = this.generation
        const session = tab?.session
        if (!tab || !session?.open || !tab.sshSession?.open) {
            this.connectedTab = null
            this.connections = []
            this.directory = null
            return
        }
        const directory = await session.getWorkingDirectory()
        if (generation !== this.generation || tab.session !== session) { return }
        const changed = directory !== this.directory
        this.directory = directory
        this.connectedTab = tab
        if (this.connections[0]?.tab !== tab || this.connections[0]?.session !== tab.sshSession) {
            this.connections = [{ tab, session: tab.sshSession }]
        }
        if (changed && this.followDirectory) { await this.jump() }
    }

    setFollow (enabled: boolean): void {
        this.followDirectory = enabled
        window.localStorage.ashFollowDirectory = String(enabled)
        if (enabled) { void this.jump() }
    }

    async jump (): Promise<void> {
        if (!this.directory || !this.sshTab || this.following) { return }
        const panel = this.panel
        if (!panel?.sftp || panel.session !== this.sshTab.sshSession) {
            this.sshTab.sftpPath = this.directory
            return
        }
        if (panel.path === this.directory) { return }
        this.following = true
        try { await panel.navigate(this.directory) } finally { this.following = false }
    }

    ngOnDestroy (): void {
        this.generation++
        clearInterval(this.timer)
        this.subscriptions.unsubscribe()
    }
}

@Injectable()
export class WorkspaceFilesProvider extends WorkspacePanelProvider {
    id = 'files'
    title = '文件'
    component = WorkspaceFilesComponent
}
