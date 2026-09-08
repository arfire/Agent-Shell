import { Injectable, OnDestroy } from '@angular/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { BehaviorSubject, Subject } from 'rxjs'
import { LogService, Logger } from 'tabby-core'

import { AIConfigService } from '../config/ai-config.service'
import { SessionEvent, SessionEventType, SessionMetadata } from './session-event'

interface SessionDetails {
    profileId?: string
    profileName?: string
    host?: string
    user?: string
    port?: number
    title?: string
}

export interface SessionPersistence {
    pending: number
    error: string
    recovered: number
}

@Injectable({ providedIn: 'root' })
export class AISessionStore implements OnDestroy {
    readonly changed = new Subject<void>()
    readonly persistence = new BehaviorSubject<SessionPersistence>({ pending: 0, error: '', recovered: 0 })
    private readonly sessionsDirectory: string
    private readonly indexPath: string
    private readonly metadata = new Map<string, SessionMetadata>()
    private readonly writes = new Map<string, Promise<void>>()
    private readonly pending = new Map<string, SessionEvent[]>()
    private readonly repairNeeded = new Set<string>()
    private readonly failures = new Map<string, string>()
    private indexWrite = Promise.resolve()
    private indexSaveTimer?: ReturnType<typeof setTimeout>
    private retryTimer?: ReturnType<typeof setTimeout>
    private indexBackupPath?: string
    private recovered = 0
    private destroyed = false
    private initialized = false
    private readonly logger: Logger
    private readonly ready: Promise<void>

    constructor (config: AIConfigService, log: LogService) {
        this.sessionsDirectory = path.join(config.directory, 'sessions')
        this.indexPath = path.join(config.directory, 'sessions.json')
        this.logger = log.create('aiSessionStore')
        this.ready = this.initialize()
    }

    async createSession (details: SessionDetails = {}): Promise<string> {
        return this.ensureSession(crypto.randomUUID(), details)
    }

    async ensureSession (id: string, details: SessionDetails = {}): Promise<string> {
        await this.ready
        if (!this.initialized) { throw new Error('会话存储暂不可用，请恢复磁盘权限或空间后重试连接') }
        this.getSessionPath(id)
        if (!this.metadata.has(id)) {
            const now = new Date().toISOString()
            this.metadata.set(id, { id, createdAt: now, updatedAt: now, nextSeq: 1, ...details })
            this.repairNeeded.add(id)
            // Keep connection details and names in the journal as well as the index.
            await this.append(id, 'session-metadata', details)
        }
        return id
    }

    async append<T> (sessionId: string, type: SessionEventType, data: T, runId?: string): Promise<SessionEvent<T>> {
        await this.ready
        await this.ensureSession(sessionId)
        const metadata = this.metadata.get(sessionId)!
        const event = JSON.parse(JSON.stringify({
            version: 1, id: crypto.randomUUID(), sessionId, seq: metadata.nextSeq++,
            time: new Date().toISOString(), type, runId, data,
        })) as SessionEvent<T>
        metadata.updatedAt = event.time
        if (type === 'user-ai-input' && !metadata.title) {
            metadata.title = String((data as { content?: unknown }).content ?? '').replace(/\s+/g, ' ').slice(0, 80)
        }
        const pending = this.pending.get(sessionId) ?? []
        pending.push(event)
        this.pending.set(sessionId, pending)
        this.publishStatus()
        if (!this.failures.has(sessionId)) { await this.drain(sessionId) }
        if (type !== 'ssh-output' && type !== 'ssh-input') { this.changed.next() }
        return event
    }

    async list (): Promise<SessionMetadata[]> {
        await this.ready
        return [...this.metadata.values()].map(entry => ({ ...entry })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    async rename (sessionId: string, title: string): Promise<void> {
        await this.ready
        const entry = this.metadata.get(sessionId)
        if (!entry) { throw new Error('会话记录不存在') }
        const name = title.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 80)
        if (!name) { throw new Error('请输入会话名称') }
        entry.title = name
        await this.append(sessionId, 'session-metadata', { ...entry })
        await this.saveIndex()
    }

    async associate (sessionId: string, details: SessionDetails): Promise<void> {
        await this.ready
        const entry = this.metadata.get(sessionId)
        if (!entry) { throw new Error('会话记录不存在') }
        Object.assign(entry, details)
        await this.append(sessionId, 'session-metadata', { ...entry })
        await this.saveIndex()
    }

    async read (sessionId: string, limit?: number): Promise<SessionEvent[]> {
        await this.ready
        await this.writes.get(sessionId)
        const events = new Map<string, SessionEvent>()
        await this.scan(sessionId, event => { events.set(event.id, event) })
        for (const event of this.pending.get(sessionId) ?? []) { events.set(event.id, event) }
        const ordered = [...events.values()].sort((a, b) => a.seq - b.seq)
        return limit ? ordered.slice(-limit) : ordered
    }

    async retrySaving (): Promise<void> {
        await this.ready
        clearTimeout(this.retryTimer)
        this.retryTimer = undefined
        if (!this.initialized) { await this.initialize(); this.changed.next(); return }
        await Promise.all([...this.pending.keys()].map(id => this.drain(id)))
        await this.saveIndex()
    }

    ngOnDestroy (): void {
        this.destroyed = true
        clearTimeout(this.indexSaveTimer)
        clearTimeout(this.retryTimer)
    }

    private async initialize (): Promise<void> {
        let rebuild = false
        try {
            await fs.promises.mkdir(this.sessionsDirectory, { recursive: true })
            try {
                const entries: unknown = JSON.parse(await fs.promises.readFile(this.indexPath, 'utf8'))
                if (!Array.isArray(entries)) { throw new Error('Invalid session index') }
                for (const entry of entries) {
                    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id) ||
                        typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string') {
                        rebuild = true
                        continue
                    }
                    this.metadata.set(entry.id, { ...entry, nextSeq: Number.isSafeInteger(entry.nextSeq) ? entry.nextSeq : 1 })
                }
            } catch (error) {
                if ((error as { code?: string }).code !== 'ENOENT') {
                    this.indexBackupPath = `${this.indexPath}.corrupt-${Date.now()}`
                    this.logger.warn('Rebuilding damaged session index:', error)
                }
                rebuild = true
            }
            const files = await fs.promises.readdir(this.sessionsDirectory)
            for (const file of files.filter(name => /^[a-zA-Z0-9_-]+\.jsonl$/.test(name))) {
                const id = file.slice(0, -6)
                let entry = this.metadata.get(id)
                const missing = !entry
                await this.scan(id, event => {
                    entry ??= { id, createdAt: event.time, updatedAt: event.time, nextSeq: 1 }
                    entry.nextSeq = Math.max(entry.nextSeq, event.seq + 1)
                    if (event.time > entry.updatedAt) { entry.updatedAt = event.time }
                    if (event.type === 'session-metadata') {
                        const details = event.data as Partial<SessionDetails>|null
                        for (const key of ['profileId', 'profileName', 'host', 'user', 'title'] as const) {
                            if (typeof details?.[key] === 'string') { entry[key] = details[key] }
                        }
                        if (details && Number.isInteger(details.port)) { entry.port = details.port }
                    } else if (event.type === 'user-ai-input' && !entry.title) {
                        entry.title = String((event.data as { content?: unknown }|null)?.content ?? '').replace(/\s+/g, ' ').slice(0, 80)
                    }
                })
                if (entry) {
                    this.metadata.set(id, entry)
                    if (missing || rebuild) { this.recovered++ }
                }
                this.repairNeeded.add(id)
            }
            if (rebuild && !this.indexBackupPath && fs.existsSync(this.indexPath)) {
                this.indexBackupPath = `${this.indexPath}.corrupt-${Date.now()}`
            }
            this.initialized = true
            await this.saveIndex()
        } catch (error) {
            this.reportFailure('index', error)
        }
        this.publishStatus()
    }

    private async scan (sessionId: string, visit: (event: SessionEvent) => void): Promise<void> {
        let handle: fs.promises.FileHandle|undefined = undefined
        try { handle = await fs.promises.open(this.getSessionPath(sessionId), 'r') } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') { return }
            throw error
        }
        const stream = handle.createReadStream({ autoClose: false })
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
        try {
            for await (const line of lines) {
                let event: any = null
                try { event = JSON.parse(line) } catch { continue }
                if (event?.version === 1 && event.sessionId === sessionId && typeof event.id === 'string' &&
                    Number.isSafeInteger(event.seq) && event.seq > 0 && typeof event.time === 'string' && typeof event.type === 'string') {
                    visit(event)
                }
            }
        } finally {
            lines.close()
            stream.destroy()
            await handle.close()
        }
    }

    private drain (sessionId: string): Promise<void> {
        const previous = this.writes.get(sessionId) ?? Promise.resolve()
        const write = previous.catch(() => undefined).then(async () => {
            const pending = this.pending.get(sessionId)
            if (!pending?.length) { return }
            await fs.promises.mkdir(this.sessionsDirectory, { recursive: true })
            if (this.repairNeeded.has(sessionId)) {
                const ids = new Set<string>()
                await this.scan(sessionId, event => { ids.add(event.id) })
                // An append can succeed on disk even when its completion reports an error.
                for (let i = pending.length - 1; i >= 0; i--) { if (ids.has(pending[i].id)) { pending.splice(i, 1) } }
                const handle = await fs.promises.open(this.getSessionPath(sessionId), 'a+')
                try {
                    const stat = await handle.stat()
                    if (stat.size) {
                        const last = Buffer.alloc(1)
                        await handle.read(last, 0, 1, stat.size - 1)
                        // Preserve a damaged final record, but never join the next JSON to it.
                        if (last[0] !== 10) { await handle.write('\n') }
                    }
                } finally { await handle.close() }
                this.repairNeeded.delete(sessionId)
            }
            while (pending.length) {
                await fs.promises.appendFile(this.getSessionPath(sessionId), JSON.stringify(pending[0]) + '\n', 'utf8')
                pending.shift()
            }
            this.pending.delete(sessionId)
            this.failures.delete(sessionId)
            this.scheduleIndexSave()
        }).catch(error => {
            this.repairNeeded.add(sessionId)
            this.reportFailure(sessionId, error)
        }).finally(() => this.publishStatus())
        this.writes.set(sessionId, write)
        return write
    }

    private getSessionPath (sessionId: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) { throw new Error('Invalid session ID') }
        return path.join(this.sessionsDirectory, `${sessionId}.jsonl`)
    }

    private saveIndex (): Promise<void> {
        this.indexWrite = this.indexWrite.catch(() => undefined).then(async () => {
            if (this.indexBackupPath) {
                await fs.promises.copyFile(this.indexPath, this.indexBackupPath)
                this.indexBackupPath = undefined
            }
            const entries = [...this.metadata.values()].map(entry => ({ ...entry }))
            await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true })
            const temporaryPath = `${this.indexPath}.tmp`
            await fs.promises.writeFile(temporaryPath, JSON.stringify(entries, null, 2), 'utf8')
            await fs.promises.rename(temporaryPath, this.indexPath)
            this.failures.delete('index')
        }).catch(error => this.reportFailure('index', error)).finally(() => this.publishStatus())
        return this.indexWrite
    }

    private scheduleIndexSave (): void {
        if (this.indexSaveTimer !== undefined || this.destroyed) { return }
        this.indexSaveTimer = setTimeout(() => {
            this.indexSaveTimer = undefined
            void this.saveIndex()
        }, 500)
    }

    private reportFailure (key: string, error: unknown): void {
        this.logger.error(`Could not persist ${key}:`, error)
        const code = (error as { code?: string }).code
        this.failures.set(key, code === 'ENOSPC' ? '磁盘空间不足' : code === 'EACCES' || code === 'EPERM' ? '没有写入权限' : '无法写入记录文件')
        if (!this.retryTimer && !this.destroyed) {
            this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.retrySaving() }, 3000)
        }
    }

    private publishStatus (): void {
        this.persistence.next({
            pending: [...this.pending.values()].reduce((sum, events) => sum + events.length, 0),
            error: [...new Set(this.failures.values())].join('；'),
            recovered: this.recovered,
        })
    }
}
