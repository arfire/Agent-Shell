import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, ProfilesService } from 'tabby-core'
import { SSHTabComponent } from 'tabby-ssh'
import { AISessionService } from './ai-session.service'
import { SessionMetadata } from './session-event'

@Injectable({ providedIn: 'root' })
export class AISessionLauncher {
    private opening = new Map<string, Promise<BaseTabComponent>>()
    private tabs = new Map<string, BaseTabComponent>()

    constructor (private app: AppService, private profiles: ProfilesService, private sessions: AISessionService) { }

    async open (entry: SessionMetadata): Promise<BaseTabComponent> {
        const pending = this.opening.get(entry.id)
        if (pending) { return pending }
        const release = this.sessions.beginOpen(entry.id)
        const opening = this.openSession(entry)
        this.opening.set(entry.id, opening)
        try { return await opening } finally { this.opening.delete(entry.id); release() }
    }

    private async openSession (entry: SessionMetadata): Promise<BaseTabComponent> {
        if (!await this.sessions.hasHistory(entry.id)) { throw new Error('会话记录不存在或已删除') }
        const runtime = this.sessions.find(entry.id)
        const existing = runtime?.tab ?? this.tabs.get(entry.id)
        if (existing instanceof SSHTabComponent && existing.aiSessionId === entry.id && (this.app.getParentTab(existing) || this.app.tabs.includes(existing))) {
            const parent = this.app.getParentTab(existing)
            this.app.selectTab(parent ?? existing)
            parent?.focus(existing)
            if (runtime?.terminal.value.state === 'closed') { await runtime.tab.reconnect() }
            return existing
        }
        this.tabs.delete(entry.id)
        const profiles = await this.profiles.getProfiles({ includeBuiltin: true })
        const matches = profiles.filter(profile => profile.type === 'ssh' && !profile.isTemplate &&
            profile.options?.host === entry.host && profile.options?.user === entry.user &&
            (profile.options?.port ?? 22) === (entry.port ?? 22))
        const profile = matches.find(candidate => candidate.id === entry.profileId) ??
            (!entry.profileId && matches.length === 1 ? matches[0] : undefined)
        if (!profile) { throw new Error('关联的服务器配置不存在或连接地址已改变，请重新关联服务器') }
        const params = await this.profiles.newTabParametersForProfile(profile)
        if (!params) { throw new Error('无法打开 SSH 连接') }
        params.inputs = { ...params.inputs, aiSessionId: entry.id }
        const tab = this.app.openNewTab(params)
        if (tab instanceof SSHTabComponent) { this.sessions.trackOpeningTab(tab, entry.id) }
        this.tabs.set(entry.id, tab)
        return tab
    }
}
