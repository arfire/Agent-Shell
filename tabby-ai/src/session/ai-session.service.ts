import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import { SSHTabComponent } from 'tabby-ssh'

import { AISessionStore } from './session-store'
import { SessionEvent } from './session-event'
import { SecretRedactor } from '../policy/secret-redactor'

export interface AISessionRuntime {
    id: string
    tab: SSHTabComponent
    events: BehaviorSubject<SessionEvent[]>
    liveText: BehaviorSubject<string>
    state: BehaviorSubject<string>
    locked: boolean
    activeRunId?: string
    stopAgent?: () => void
    handoffAgent?: () => Promise<void>
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
            host: tab.profile.options.host,
            user: tab.profile.options.user,
        }
        const id = tab.aiSessionId
            ? await this.store.ensureSession(tab.aiSessionId, details)
            : await this.store.createSession(details)
        tab.aiSessionId = id
        const runtime: AISessionRuntime = {
            id,
            tab,
            events: new BehaviorSubject(await this.store.read(id)),
            liveText: new BehaviorSubject(''),
            state: new BehaviorSubject('IDLE'),
            locked: false,
            terminal: new BehaviorSubject({ mode: 'agent' as const, ready: false, notice: '正在连接 Shell…', state: 'initializing' }),
        }
        this.sessions.set(tab, runtime)
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

    async append<T> (runtime: AISessionRuntime, type: SessionEvent['type'], data: T, runId?: string): Promise<SessionEvent<T>> {
        const protectedData = this.protectStoredValue(data) as T
        const event = await this.store.append(runtime.id, type, protectedData, runId)
        runtime.events.next([...runtime.events.value, event])
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
