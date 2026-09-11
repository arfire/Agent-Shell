import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core'
import { from, Subscription } from 'rxjs'

import { AISessionRuntime } from '../session/ai-session.service'
import { AgentInteractionService, ApprovalRequest, FormRequest, InteractionOwner } from '../agent/interaction.service'
import { TerminalControllerService } from '../terminal/terminal-controller.service'
import { ApprovalMode } from '../config/config-schema'
import { AgentPermissionsService } from '../policy/agent-permissions.service'
import { AISessionStore } from '../session/session-store'
import { historyChunks } from '../terminal/session-history'
import { terminalText } from '../terminal/terminal-text'
import { TerminalHistoryFilter } from '../terminal/terminal-history-filter'
import { SessionEvent } from '../session/session-event'

@Component({
    selector: 'ash-agent-dock',
    templateUrl: './agent-dock.component.pug',
    styleUrls: ['./agent-dock.component.scss'],
})
export class AgentDockComponent implements OnInit, OnDestroy, AfterViewChecked {
    @Input() runtime: AISessionRuntime
    requests: ApprovalRequest[] = []
    forms: FormRequest[] = []
    commands = new Map<string, string>()
    values = new Map<string, string>()
    confirmed = new Set<string>()
    changingPermission = false
    showFailure = false
    configReady = false
    draft = ''
    transcript = ''
    showTranscript = true
    @ViewChild('transcriptView') transcriptView?: ElementRef<HTMLElement>
    followOutput = true
    private scrollPending = false
    private historyOutput = new TerminalHistoryFilter()
    private historyText = ''
    private historyContext = ''
    private historyCount = 0
    private historyLast?: SessionEvent
    private subscriptions: Subscription[] = []

    constructor (
        public terminal: TerminalControllerService,
        public permissions: AgentPermissionsService,
        public store: AISessionStore,
        private interactions: AgentInteractionService,
        private changeDetector: ChangeDetectorRef,
        private zone: NgZone,
    ) { }

    ngOnInit (): void {
        this.subscriptions.push(this.runtime.events.subscribe(events => {
            if (this.historyContext !== this.runtime.id || events.length < this.historyCount ||
                this.historyCount > 0 && events[this.historyCount - 1] !== this.historyLast) {
                this.historyOutput = new TerminalHistoryFilter()
                this.historyText = ''
                this.historyCount = 0
                this.historyContext = this.runtime.id
            }
            for (const chunk of historyChunks(events.slice(this.historyCount), this.historyOutput, false)) {
                this.historyText = (this.historyText + chunk).slice(-200000)
            }
            this.historyCount = events.length
            this.historyLast = events.at(-1)
            this.transcript = terminalText(this.historyText + this.historyOutput.peek()).trim()
            this.scrollPending = true
            this.refresh()
        }))
        this.subscriptions.push(this.runtime.liveText.subscribe(() => { this.scrollPending = true; this.refresh() }))
        this.subscriptions.push(
            from(this.permissions.config.ready).subscribe(() => {
                this.configReady = true
                this.refresh()
            }),
            this.permissions.config.changed.subscribe(() => this.refresh()),
            this.runtime.terminal.subscribe(() => this.refresh()),
            this.runtime.state.subscribe(() => this.refresh()),
            this.interactions.requests.subscribe(() => this.refresh()),
            this.interactions.forms.subscribe(() => this.refresh()),
        )
    }

    ngOnDestroy (): void {
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.values.clear()
        this.commands.clear()
        this.confirmed.clear()
    }

    send (): void {
        if (this.terminal.sendRequest(this.runtime, this.draft)) {
            this.draft = ''
            this.showTranscript = true
            this.followOutput = true
            this.scrollPending = true
        }
    }

    ngAfterViewChecked (): void {
        const element = this.transcriptView?.nativeElement
        if (element && this.scrollPending) {
            this.scrollPending = false
            if (this.followOutput) { element.scrollTop = element.scrollHeight }
        }
    }

    transcriptScrolled (): void {
        const element = this.transcriptView?.nativeElement
        if (element) { this.followOutput = element.scrollHeight - element.scrollTop - element.clientHeight < 24 }
    }

    composerKey (event: KeyboardEvent): void {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault()
            this.send()
        }
    }

    private refresh (): void {
        this.requests = this.interactions.requests.value.filter(request => this.owns(request))
        this.forms = this.interactions.forms.value.filter(form => this.owns(form))
        const requests = new Set(this.requests.map(request => request.id))
        const forms = new Set(this.forms.map(form => form.id))
        for (const id of this.commands.keys()) {
            if (!requests.has(id)) { this.commands.delete(id); this.confirmed.delete(id) }
        }
        for (const request of this.requests) {
            if (!this.commands.has(request.id)) { this.commands.set(request.id, request.command) }
        }
        for (const id of this.values.keys()) {
            if (!forms.has(id)) { this.values.delete(id) }
        }
        this.zone.run(() => this.changeDetector.markForCheck())
    }

    private get owner (): InteractionOwner {
        return { sessionId: this.runtime.id, connectionId: this.runtime.connectionId, runId: this.runtime.activeRunId ?? '' }
    }

    private owns (request: InteractionOwner): boolean {
        return this.runtime.terminal.value.state !== 'closed' && !!this.runtime.activeRunId &&
            request.sessionId === this.runtime.id && request.connectionId === this.runtime.connectionId &&
            request.runId === this.runtime.activeRunId
    }

    get statusLabel (): string {
        return ({ QUEUED: '等待中', THINKING: '思考中', EXECUTING: '执行中', OBSERVING: '检查结果',
            WAITING_APPROVAL: '等待审批', WAITING_INTERACTION: '等待输入', DONE: '已完成', CANCELLED: '已停止', FAILED: '失败',
        } as Partial<Record<string, string>>)[this.runtime.state.value] ?? ''
    }

    get defaultPermissionLabel (): string {
        const mode = this.permissions.config.config.policy.approvalMode ?? 'configured'
        return this.permissions.modes.find(item => item.value === mode)?.label ?? '按配置执行'
    }

    edit (request: ApprovalRequest, value: string): void {
        if (!this.owns(request) || !this.requests.includes(request)) { return }
        this.commands.set(request.id, value)
        this.confirmed.delete(request.id)
    }

    approve (request: ApprovalRequest): void {
        if (!this.owns(request) || !this.requests.includes(request)) { return }
        if (request.confirmationsRequired > 1 && !this.confirmed.has(request.id)) {
            this.confirmed.add(request.id)
            return
        }
        this.interactions.resolve(request.id, { approved: true, command: this.commands.get(request.id) ?? request.command }, this.owner)
        this.runtime.tab.frontend?.focus()
    }

    reject (request: ApprovalRequest): void {
        if (!this.owns(request) || !this.requests.includes(request)) { return }
        this.interactions.resolve(request.id, { approved: false, command: request.command }, this.owner)
        this.runtime.tab.frontend?.focus()
    }

    submitForm (form: FormRequest, submitted = true): void {
        if (!this.owns(form) || !this.forms.includes(form)) { this.values.delete(form.id); return }
        const value = submitted ? this.values.get(form.id) ?? '' : ''
        this.values.delete(form.id)
        this.interactions.resolveForm(form.id, { submitted, value }, this.owner)
        this.runtime.tab.frontend?.focus()
    }

    async toggleMode (): Promise<void> {
        await this.terminal.setMode(this.runtime, this.runtime.terminal.value.mode === 'agent' ? 'shell' : 'agent')
        this.runtime.tab.frontend?.focus()
    }

    async retryIntegration (): Promise<void> {
        this.showFailure = false
        await this.terminal.retryIntegration(this.runtime)
        this.runtime.tab.frontend?.focus()
    }

    async changePermission (value: ApprovalMode|'', select?: HTMLSelectElement): Promise<void> {
        this.changingPermission = true
        try {
            const mode = value || (this.permissions.config.config.policy.approvalMode ?? 'configured')
            if (await this.permissions.confirmMode(mode)) {
                this.runtime.approvalMode = value || undefined
            }
        } finally {
            if (select) { select.value = this.runtime.approvalMode ?? '' }
            this.changingPermission = false
            this.refresh()
        }
    }
}
