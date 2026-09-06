import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'

import { AISessionRuntime } from '../session/ai-session.service'
import { SessionEvent } from '../session/session-event'
import { TerminalControllerService } from './terminal-controller.service'
import { terminalText } from './terminal-text'
import { TerminalMarkdown, terminalMarkdown } from './terminal-markdown'

interface Presentation {
    runtime: AISessionRuntime
    subscriptions: Subscription[]
    pending: string
    live: string
    filter: TerminalMarkdown
    paused: boolean
    lineEnded: boolean
    timer?: ReturnType<typeof setTimeout>
    seq: number
}

/** Append-only native terminal output. Styling comes from Ash, never model escapes. */
@Injectable({ providedIn: 'root' })
export class AgentTerminalPresenter {
    private runs = new Map<string, Presentation>()

    constructor (private terminal: TerminalControllerService) { }

    async open (runtime: AISessionRuntime, runId: string, _stop?: () => void, _seq = 0): Promise<void> {
        if (runtime.state.value === 'WAITING_INTERACTION' && this.terminal.isExecuting(runtime)) {
            return
        }
        await this.terminal.waitForPrompt(runtime)
        this.terminal.setLocalPresentation(runtime, true)
        const existing = this.runs.get(runId)
        if (existing) {
            if (existing.paused) { await runtime.tab.write('\r\n') }
            existing.paused = false
            await this.flush(existing)
            return
        }
        const presentation: Presentation = {
            runtime, subscriptions: [], pending: '', live: '', paused: false, lineEnded: true,
            filter: new TerminalMarkdown(),
            seq: runtime.events.value.at(-1)?.seq ?? 0,
        }
        this.runs.set(runId, presentation)
        await runtime.tab.write('\x1b[36mAgent\x1b[0m\r\n')
        presentation.subscriptions.push(runtime.liveText.subscribe(text => {
            if (!text) {
                if (presentation.live) { presentation.pending += presentation.filter.finish() + '\r\n' }
                presentation.live = ''
                presentation.filter = new TerminalMarkdown()
            } else {
                const delta = text.startsWith(presentation.live) ? text.slice(presentation.live.length) : text
                presentation.pending += presentation.filter.feed(delta)
                presentation.live = text
            }
            this.schedule(presentation)
        }))
        presentation.subscriptions.push(runtime.events.subscribe(events => {
            for (const event of events) {
                if (event.seq <= presentation.seq) { continue }
                presentation.seq = event.seq
                if (event.runId === runId) { this.event(presentation, event) }
            }
            this.schedule(presentation)
        }))
    }

    async interrupt (runId: string): Promise<void> {
        const presentation = this.runs.get(runId)
        if (presentation) {
            await this.flush(presentation)
            presentation.paused = true
            this.terminal.setLocalPresentation(presentation.runtime, false)
        }
    }

    async finish (runId: string): Promise<void> {
        const presentation = this.runs.get(runId)
        if (!presentation) { return }
        clearTimeout(presentation.timer)
        presentation.subscriptions.forEach(subscription => subscription.unsubscribe())
        presentation.pending += presentation.filter.finish()
        try {
            if (presentation.runtime.terminal.value.mode === 'agent' && !this.terminal.isExecuting(presentation.runtime)) {
                await this.terminal.waitForPrompt(presentation.runtime)
                presentation.paused = false
                await this.flush(presentation)
                if (!presentation.lineEnded) { await presentation.runtime.tab.write('\r\n') }
            }
        } finally {
            this.terminal.setLocalPresentation(presentation.runtime, false)
            this.runs.delete(runId)
        }
    }

    detachSession (sessionId: string): void {
        for (const [id, presentation] of this.runs) {
            if (presentation.runtime.id !== sessionId) { continue }
            clearTimeout(presentation.timer)
            presentation.subscriptions.forEach(subscription => subscription.unsubscribe())
            this.terminal.setLocalPresentation(presentation.runtime, false)
            this.runs.delete(id)
        }
    }

    private event (presentation: Presentation, event: SessionEvent): void {
        const data = event.data as Record<string, unknown>
        if (event.type === 'ai-message' && !presentation.live) {
            presentation.pending += terminalMarkdown(String(data.content ?? '')) + '\r\n'
        } else if (event.type === 'ai-command') {
            presentation.pending += '\r\n\x1b[2m' + terminalText(String(data.reason ?? '')) + '\x1b[0m\r\n' +
                '$ ' + terminalText(String(data.command ?? '')) + '\r\n'
        } else if (event.type === 'error') {
            presentation.pending += '\r\n\x1b[31mAgent: ' + terminalText(String(data.message ?? '')) + '\x1b[0m\r\n'
        }
    }

    private schedule (presentation: Presentation): void {
        if (presentation.timer !== undefined || presentation.paused) { return }
        presentation.timer = setTimeout(() => {
            presentation.timer = undefined
            void this.flush(presentation).catch(() => this.detachSession(presentation.runtime.id))
        }, 40)
    }

    private async flush (presentation: Presentation): Promise<void> {
        if (presentation.paused || !presentation.pending || this.terminal.isExecuting(presentation.runtime) ||
            presentation.runtime.terminal.value.mode !== 'agent' || presentation.runtime.terminal.value.state !== 'prompt') { return }
        const text = presentation.pending
        presentation.pending = ''
        await presentation.runtime.tab.write(text)
        presentation.lineEnded = /\n(?:\x1b\[[\d;]*m)*$/.test(text)
    }
}
