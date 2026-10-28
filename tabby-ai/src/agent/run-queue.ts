import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'

interface QueueEntry {
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    signal?: AbortSignal
}

@Injectable({ providedIn: 'root' })
export class AgentRunQueue {
    private active = 0
    private waiting: QueueEntry[] = []

    constructor (private config: AIConfigService) { }

    acquire (signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error('Agent run cancelled'))
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal }
            this.waiting.push(entry)
            signal?.addEventListener('abort', () => {
                const index = this.waiting.indexOf(entry)
                if (index >= 0) {
                    this.waiting.splice(index, 1)
                    reject(signal.reason ?? new Error('Agent run cancelled'))
                }
            }, { once: true })
            this.drain()
        })
    }

    private drain (): void {
        const limit = this.config.config.agent.maxConcurrentRuns
        while (this.active < limit && this.waiting.length) {
            const entry = this.waiting.shift()!
            if (entry.signal?.aborted) {
                entry.reject(entry.signal.reason ?? new Error('Agent run cancelled'))
                continue
            }
            this.active++
            let released = false
            entry.resolve(() => {
                if (released) {
                    return
                }
                released = true
                this.active--
                this.drain()
            })
        }
    }
}
