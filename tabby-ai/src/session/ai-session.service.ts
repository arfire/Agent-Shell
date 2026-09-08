import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import * as crypto from 'crypto'
import { SSHTabComponent } from 'tabby-ssh'

import { AISessionStore } from './session-store'
import { SessionEvent } from './session-event'
import { SecretRedactor } from '../policy/secret-redactor'
import { ApprovalMode } from '../config/config-schema'

export interface AISessionRuntime {
    id: string
    /** Identifies this live SSH tab, independent of the selected transcript. */
    connectionId: string
    tab: SSHTabComponent
    events: BehaviorSubject<SessionEvent[]>
    liveText: BehaviorSubject<string>
    state: BehaviorSubject<string>
    locked: boolean
    activeRunId?: string
    stopAgent?: () => void
    handoffAgent?: () => Promise<void>
    flushOutput?: () => void
    historyToRestore?: SessionEvent[]
    approvalMode?: ApprovalMode
    shellKind?: string
    terminal: BehaviorSubject<{
        mode: 'agent'|'shell'
        ready: boolean
        notice: string
        state: string
    }>
}

@Injectable({ providedIn: 'root' })
export class AISessionService {
    private readonly sessions = new Map<SSHTabComponent, AISessionRuntime>()
    private readonly pendingAttachments = new Map<SSHTabComponent, Promise<AISessionRuntime>>()
    private readonly loadingContexts = new Set<string>()

    constructor (
        private store: AISessionStore,
        private redactor: SecretRedactor,
    ) { }

    async attach (tab: SSHTabComponent): Promise<AISessionRuntime> {
        const existing = this.sessions.get(tab)
        if (existing) {
            return existing
        }
        const pending = this.pendingAttachments.get(tab)
        if (pending) {
            return pending
        }
        const attachment = this.createRuntime(tab)
        this.pendingAttachments.set(tab, attachment)
        try {
            return await attachment
        } finally {
            this.pendingAttachments.delete(tab)
        }
    }

    private async createRuntime (tab: SSHTabComponent): Promise<AISessionRuntime> {
        const details = {
            profileId: tab.profile.id,
            profileName: tab.profile.name,
            host: tab.profile.options.host,
            user: tab.profile.options.user,
            port: tab.profile.options.port ?? 22,
        }
        const requestedId = tab.aiSessionId
        const canRestore = requestedId && !this.loadingContexts.has(requestedId) &&
            ![...this.sessions.values()].some(runtime => runtime.id === requestedId)
        if (canRestore) { this.loadingContexts.add(requestedId) }
        let id = ''
        let events: SessionEvent[] = []
        try {
            id = canRestore ? await this.store.ensureSession(requestedId, details) : await this.store.createSession(details)
            events = await this.store.read(id)
        } catch (error) {
            if (canRestore) { this.loadingContexts.delete(requestedId) }
            throw error
        }
        tab.aiSessionId = id
        const runtime: AISessionRuntime = {
            id,
            connectionId: crypto.randomUUID(),
            tab,
            events: new BehaviorSubject(events),
            historyToRestore: events.length ? events : undefined,
            liveText: new BehaviorSubject(''),
            state: new BehaviorSubject('IDLE'),
            locked: false,
            terminal: new BehaviorSubject({ mode: 'agent' as const, ready: false, notice: '正在连接 Shell…', state: 'initializing' }),
        }
        this.sessions.set(tab, runtime)
        if (canRestore) { this.loadingContexts.delete(requestedId) }
        return runtime
    }

    detach (tab: SSHTabComponent): void {
        const runtime = this.sessions.get(tab)
        runtime?.events.complete()
        runtime?.liveText.complete()
        runtime?.state.complete()
        runtime?.terminal.complete()
        this.sessions.delete(tab)
    }

    get (tab: SSHTabComponent): AISessionRuntime|undefined {
        return this.sessions.get(tab)
    }

    find (sessionId: string): AISessionRuntime|undefined {
        return [...this.sessions.values()].find(runtime => runtime.id === sessionId)
    }

    async selectContext (runtime: AISessionRuntime, sessionId?: string): Promise<void> {
        if (!!runtime.activeRunId || runtime.locked) { throw new Error('请先停止当前 Agent，再切换会话') }
        if (sessionId === runtime.id) { return }
        if (sessionId && (this.loadingContexts.has(sessionId) || [...this.sessions.values()].some(other => other !== runtime && other.id === sessionId))) {
            throw new Error('这个 Agent 会话已在另一个终端打开，请先切换到该终端')
        }
        runtime.locked = true
        runtime.flushOutput?.()
        if (sessionId) { this.loadingContexts.add(sessionId) }
        runtime.state.next('LOADING_CONTEXT')
        try {
            const entries = await this.store.list()
            if (sessionId && !entries.some(entry => entry.id === sessionId)) { throw new Error('会话记录不存在') }
            const id = sessionId ?? await this.store.createSession({
                profileId: runtime.tab.profile.id,
                profileName: runtime.tab.profile.name,
                host: runtime.tab.profile.options.host,
                user: runtime.tab.profile.options.user,
                port: runtime.tab.profile.options.port ?? 22,
            })
            const events = await this.store.read(id)
            if (this.sessions.get(runtime.tab) !== runtime) { throw new Error('终端已关闭') }
            runtime.id = id
            runtime.tab.aiSessionId = id
            runtime.events.next(events)
            runtime.liveText.next('')
        } finally {
            if (sessionId) { this.loadingContexts.delete(sessionId) }
            runtime.locked = false
            runtime.state.next('IDLE')
        }
    }

    async append<T> (runtime: AISessionRuntime, type: SessionEvent['type'], data: T, runId?: string): Promise<SessionEvent<T>> {
        runtime.flushOutput?.()
        return this.appendToContext(runtime, runtime.id, type, data, runId)
    }

    async appendToContext<T> (runtime: AISessionRuntime, id: string, type: SessionEvent['type'], data: T, runId?: string): Promise<SessionEvent<T>> {
        const protectedData = this.protectStoredValue(data) as T
        const event = await this.store.append(id, type, protectedData, runId)
        if (runtime.id === id) { runtime.events.next([...runtime.events.value, event]) }
        return event
    }

    private protectStoredValue (value: unknown): unknown {
        if (typeof value === 'string') {
            return this.redactor.redact(value)
        }
        if (Array.isArray(value)) {
            return value.map(item => this.protectStoredValue(item))
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.protectStoredValue(item)]))
        }
        return value
    }
}
