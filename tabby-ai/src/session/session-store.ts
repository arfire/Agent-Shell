import { Injectable } from '@angular/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { LogService, Logger } from 'tabby-core'

import { AIConfigService } from '../config/ai-config.service'
import { SessionEvent, SessionEventType, SessionMetadata } from './session-event'

@Injectable({ providedIn: 'root' })
export class AISessionStore {
    private readonly sessionsDirectory: string
    private readonly indexPath: string
    private readonly metadata = new Map<string, SessionMetadata>()
    private readonly writes = new Map<string, Promise<void>>()
    private indexWrite = Promise.resolve()
    private indexSaveTimer?: ReturnType<typeof setTimeout>
    private readonly logger: Logger
    private ready: Promise<void>

    constructor (config: AIConfigService, log: LogService) {
        this.sessionsDirectory = path.join(config.directory, 'sessions')
        this.indexPath = path.join(config.directory, 'sessions.json')
        this.logger = log.create('aiSessionStore')
        this.ready = this.initialize()
    }

    async createSession (details: Pick<SessionMetadata, 'profileId'|'host'|'user'> = {}): Promise<string> {
        await this.ready
        const now = new Date().toISOString()
        const id = crypto.randomUUID()
        this.metadata.set(id, {
            id,
            createdAt: now,
            updatedAt: now,
            nextSeq: 1,
            ...details,
        })
        await this.saveIndex()
        return id
    }

    async ensureSession (id: string, details: Pick<SessionMetadata, 'profileId'|'host'|'user'> = {}): Promise<string> {
        await this.ready
        if (!this.metadata.has(id)) {
            const now = new Date().toISOString()
            this.metadata.set(id, {
                id,
                createdAt: now,
                updatedAt: now,
                nextSeq: await this.findNextSequence(id),
                ...details,
            })
            await this.saveIndex()
        }
        return id
    }

    async append<T> (sessionId: string, type: SessionEventType, data: T, runId?: string): Promise<SessionEvent<T>> {
        await this.ready
        await this.ensureSession(sessionId)
        const metadata = this.metadata.get(sessionId)!
        const event: SessionEvent<T> = {
            version: 1,
            id: crypto.randomUUID(),
            sessionId,
            seq: metadata.nextSeq++,
            time: new Date().toISOString(),
            type,
            runId,
            data,
        }
        metadata.updatedAt = event.time

        const previous = this.writes.get(sessionId) ?? Promise.resolve()
        const write = previous.then(async () => {
            await fs.promises.appendFile(this.getSessionPath(sessionId), JSON.stringify(event) + '\n', 'utf8')
            this.scheduleIndexSave()
        }).catch(error => {
            this.logger.error(`Could not append event to ${sessionId}:`, error)
            throw error
        })
        this.writes.set(sessionId, write)
        await write
        return event
    }

    async read (sessionId: string, limit?: number): Promise<SessionEvent[]> {
        await this.ready
        const sessionPath = this.getSessionPath(sessionId)
        if (!fs.existsSync(sessionPath)) {
            return []
        }
        const lines = (await fs.promises.readFile(sessionPath, 'utf8')).split(/\r?\n/).filter(Boolean)
        const selected = limit ? lines.slice(-limit) : lines
        const events: SessionEvent[] = []
        for (const line of selected) {
            try {
                events.push(JSON.parse(line))
            } catch (error) {
                this.logger.warn(`Ignoring damaged event in ${sessionId}:`, error)
            }
        }
        return events
    }

    private async initialize (): Promise<void> {
        await fs.promises.mkdir(this.sessionsDirectory, { recursive: true })
        if (!fs.existsSync(this.indexPath)) {
            await this.saveIndex()
            return
        }
        try {
            const entries = JSON.parse(await fs.promises.readFile(this.indexPath, 'utf8')) as SessionMetadata[]
            for (const entry of entries) {
                entry.nextSeq = Math.max(entry.nextSeq, await this.findNextSequenceFromDisk(entry.id))
                this.metadata.set(entry.id, entry)
            }
        } catch (error) {
            this.logger.error('Could not read sessions.json; session logs remain intact:', error)
        }
    }

    private async findNextSequence (sessionId: string): Promise<number> {
        return this.findNextSequenceFromDisk(sessionId)
    }

    private async findNextSequenceFromDisk (sessionId: string): Promise<number> {
        const sessionPath = this.getSessionPath(sessionId)
        if (!fs.existsSync(sessionPath)) {
            return 1
        }
        const handle = await fs.promises.open(sessionPath, 'r')
        try {
            const stat = await handle.stat()
            const length = Math.min(stat.size, 65536)
            const buffer = Buffer.alloc(length)
            await handle.read(buffer, 0, length, stat.size - length)
            const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean).reverse()
            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as SessionEvent
                    if (Number.isInteger(event.seq)) {
                        return event.seq + 1
                    }
                } catch {
                    // A crash may leave the final JSONL record incomplete.
                }
            }
            return 1
        } finally {
            await handle.close()
        }
    }

    private getSessionPath (sessionId: string): string {
        return path.join(this.sessionsDirectory, `${sessionId}.jsonl`)
    }

    private async saveIndex (): Promise<void> {
        const entries = [...this.metadata.values()]
        this.indexWrite = this.indexWrite.catch(() => undefined).then(async () => {
            await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true })
            const temporaryPath = `${this.indexPath}.tmp`
            await fs.promises.writeFile(temporaryPath, JSON.stringify(entries, null, 2), 'utf8')
            await fs.promises.rename(temporaryPath, this.indexPath)
        })
        await this.indexWrite
    }

    private scheduleIndexSave (): void {
        if (this.indexSaveTimer) {
            return
        }
        this.indexSaveTimer = setTimeout(() => {
            this.indexSaveTimer = undefined
            void this.saveIndex().catch(error => this.logger.error('Could not update the AI session index:', error))
        }, 500)
    }
}
