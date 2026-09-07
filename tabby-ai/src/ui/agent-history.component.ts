import { Component, Injectable, Input, OnDestroy, OnInit } from '@angular/core'
import { BaseTabComponent, WorkspacePanelProvider, ProfilesService, PartialProfile, Profile } from 'tabby-core'
import { SSHTabComponent } from 'tabby-ssh'
import { Subscription } from 'rxjs'
import { AISessionStore } from '../session/session-store'
import { AISessionRuntime, AISessionService } from '../session/ai-session.service'
import { SessionMetadata } from '../session/session-event'
import { AISessionLauncher } from '../session/session-launcher.service'
import { AgentTerminalPresenter } from '../terminal/agent-terminal-presenter'
import { TerminalControllerService } from '../terminal/terminal-controller.service'
import { SecretRedactor } from '../policy/secret-redactor'

@Component({
    selector: 'agent-history',
    templateUrl: './agent-history.component.pug',
    styleUrls: ['./agent-history.component.scss'],
})
export class AgentHistoryComponent implements OnInit, OnDestroy {
    @Input() tab: BaseTabComponent|null = null
    entries: SessionMetadata[] = []
    selected: SessionMetadata|null = null
    preview = ''
    query = ''
    allServers = false
    busy = false
    error = ''
    notice = ''
    confirmedTarget = ''
    renameId = ''
    renameText = ''
    linking = false
    profileId = ''
    profiles: PartialProfile<Profile>[] = []
    private subscription?: Subscription
    private generation = 0

    constructor (
        private store: AISessionStore,
        public sessions: AISessionService,
        private launcher: AISessionLauncher,
        private profilesService: ProfilesService,
        private presenter: AgentTerminalPresenter,
        private terminal: TerminalControllerService,
        private redactor: SecretRedactor,
    ) { }

    get ssh (): SSHTabComponent|null { return this.tab instanceof SSHTabComponent ? this.tab : null }
    get runtime (): AISessionRuntime|undefined { return this.ssh ? this.sessions.get(this.ssh) : undefined }
    get target (): string { return this.ssh ? `${this.ssh.profile.options.user}@${this.ssh.profile.options.host}:${this.ssh.profile.options.port ?? 22}` : '' }
    get disabled (): boolean { return this.busy || !this.runtime || !!this.runtime.activeRunId || this.runtime.locked }

    matches (entry: SessionMetadata): boolean {
        return !!this.ssh && entry.host === this.ssh.profile.options.host && entry.user === this.ssh.profile.options.user &&
            (entry.port ?? 22) === (this.ssh.profile.options.port ?? 22)
    }

    get groups (): { name: string, entries: SessionMetadata[] }[] {
        const groups = new Map<string, SessionMetadata[]>()
        for (const entry of this.entries) {
            if (!this.allServers && this.ssh && !this.matches(entry)) { continue }
            const name = entry.host ? `${entry.profileName ? entry.profileName + ' · ' : ''}${entry.user ?? ''}@${entry.host}:${entry.port ?? 22}` : '未关联服务器'
            if (this.query && !(name + (entry.title ?? '')).toLowerCase().includes(this.query.toLowerCase())) { continue }
            const values = groups.get(name) ?? []
            values.push(entry)
            groups.set(name, values)
        }
        return [...groups].map(([name, entries]) => ({ name, entries }))
    }

    groupKey (_index: number, group: { name: string }): string { return group.name }
    entryKey (_index: number, entry: SessionMetadata): string { return entry.id }

    ngOnInit (): void {
        this.subscription = this.store.changed.subscribe(() => { void this.refresh() })
        void this.refresh()
    }

    async refresh (): Promise<void> {
        try {
            this.entries = await this.store.list()
            if (this.selected) { this.selected = this.entries.find(entry => entry.id === this.selected?.id) ?? null }
        } catch (error) { this.error = String(error) }
    }

    startRename (entry: SessionMetadata): void {
        this.renameId = entry.id
        this.renameText = entry.title ?? ''
    }

    async rename (): Promise<void> {
        try {
            await this.store.rename(this.renameId, this.redactor.redact(this.renameText))
            this.renameId = ''
        } catch (error) { this.error = String(error) }
    }

    async open (entry: SessionMetadata): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.linking = false
        this.error = ''
        try {
            await this.inspect(entry)
            await this.launcher.open(entry)
            this.notice = '已打开对应终端，连接就绪后显示历史记录。'
        } catch (error) {
            this.error = String(error)
            this.profiles = (await this.profilesService.getProfiles({ includeBuiltin: true })).filter(profile => profile.type === 'ssh' && !profile.isTemplate)
            this.profileId = ''
            this.linking = true
        } finally { this.busy = false }
    }

    async associate (): Promise<void> {
        const entry = this.selected
        const profile = this.profiles.find(candidate => candidate.id === this.profileId)
        if (!entry || !profile || this.busy) { return }
        try {
            await this.store.associate(entry.id, {
                profileId: profile.id, profileName: profile.name,
                host: profile.options?.host, user: profile.options?.user, port: profile.options?.port ?? 22,
            })
            const updated = (await this.store.list()).find(candidate => candidate.id === entry.id)!
            await this.open(updated)
        } catch (error) { this.error = String(error) }
    }

    async inspect (entry: SessionMetadata): Promise<void> {
        const generation = ++this.generation
        this.selected = entry
        this.preview = '正在读取…'
        this.confirmedTarget = ''
        this.error = ''
        try {
            const events = await this.store.read(entry.id, 200)
            if (generation !== this.generation) { return }
            this.preview = events.filter(event => ['user-ai-input', 'ai-message', 'ssh-input', 'ssh-output', 'command-result'].includes(event.type)).map(event => {
                const data = event.data as Record<string, unknown>
                const content = event.type === 'command-result' ? JSON.stringify(data) : data.content
                const label = event.type.startsWith('ssh-') ? 'Shell' : event.type === 'user-ai-input' ? '你' : 'Agent'
                return `${label} · ${event.time}\n${String(content ?? '').slice(0, 12000)}`
            }).join('\n\n').slice(-60000) || '这次会话还没有对话记录。'
        } catch (error) { if (generation === this.generation) { this.error = String(error); this.preview = '' } }
    }

    async load (entry?: SessionMetadata): Promise<void> {
        const runtime = this.runtime
        if (!runtime || this.disabled) { return }
        if (!this.terminal.canRestoreHistory(runtime)) {
            this.error = '请先结束 Shell 输入或命令，再切换会话'
            return
        }
        if (entry && !this.matches(entry) && this.confirmedTarget !== this.target + entry.id) {
            this.confirmedTarget = this.target + entry.id
            this.notice = `此记录来自其他服务器。再次点击继续，将在 ${this.target} 使用该上下文。`
            return
        }
        this.busy = true
        this.error = ''
        try {
            await this.sessions.selectContext(runtime, entry?.id)
            if (entry) { await this.presenter.replay(runtime, runtime.events.value.slice()) }
            this.notice = `${entry ? '已加载上下文' : '已新建 Agent 会话'}，当前连接：${runtime.tab.profile.options.host}`
            runtime.terminal.next({ ...runtime.terminal.value, notice: this.notice })
            this.confirmedTarget = ''
            await this.refresh()
        } catch (error) { this.error = String(error) } finally { this.busy = false }
    }

    ngOnDestroy (): void {
        this.generation++
        this.subscription?.unsubscribe()
    }
}

@Injectable()
export class AgentHistoryProvider extends WorkspacePanelProvider {
    id = 'agent'
    title = 'Agent'
    component = AgentHistoryComponent
}
