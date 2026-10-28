import { ChangeDetectorRef, Component, ElementRef, HostBinding, Input, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core'
import { from, Subscription } from 'rxjs'

import { AISessionRuntime } from '../session/ai-session.service'
import { AgentInteractionService, ApprovalRequest, FormRequest, InteractionOwner } from '../agent/interaction.service'
import { TerminalControllerService } from '../terminal/terminal-controller.service'
import { ApprovalMode } from '../config/config-schema'
import { AgentPermissionsService } from '../policy/agent-permissions.service'
import { AISessionStore } from '../session/session-store'
import { commandRiskDescription } from '../policy/command-description'

interface ContextMessage { label: string, text: string, expanded: boolean }
interface ContextPreview { formatted: string, protectedCount: number, messages: ContextMessage[] }

@Component({
    selector: 'ash-agent-dock',
    templateUrl: './agent-dock.component.pug',
    styleUrls: ['./agent-dock.component.scss'],
})
export class AgentDockComponent implements OnInit, OnDestroy {
    @Input() runtime: AISessionRuntime
    @HostBinding('class.awaiting-input') get awaitingInput (): boolean { return !!(this.requests.length || this.forms.length) }
    requests: ApprovalRequest[] = []
    forms: FormRequest[] = []
    commands = new Map<string, string>()
    values = new Map<string, string>()
    confirmed = new Set<string>()
    changingPermission = false
    showFailure = false
    configReady = false
    showContext = false
    @ViewChild('contextToggle') contextToggle?: ElementRef<HTMLButtonElement>
    @ViewChild('contextPanel') contextPanel?: ElementRef<HTMLElement>
    private subscriptions: Subscription[] = []
    private contextCache = new Map<string, ContextPreview>()

    constructor (
        public terminal: TerminalControllerService,
        public permissions: AgentPermissionsService,
        public store: AISessionStore,
        private interactions: AgentInteractionService,
        private changeDetector: ChangeDetectorRef,
        private zone: NgZone,
    ) { }

    ngOnInit (): void {
        this.subscriptions.push(this.runtime.events.subscribe(() => this.refresh()))
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
        this.contextCache.clear()
        this.runtime.tab.element?.nativeElement.style.removeProperty('--ash-context-width')
    }

    toggleContext (): void {
        this.showContext = !this.showContext
        this.runtime.tab.element.nativeElement.style.setProperty('--ash-context-width', this.showContext ? 'min(420px, 45%)' : '0px')
        setTimeout(() => {
            if (this.showContext) { this.contextPanel?.nativeElement.focus() } else { this.contextToggle?.nativeElement.focus() }
        })
    }

    get contextRequest (): NonNullable<AISessionRuntime['modelRequests']>[number]|undefined {
        return this.runtime.modelRequests?.filter(request => request.sessionId === this.runtime.id).at(-1)
    }

    contextMessages (body: string): ContextMessage[] {
        return this.cachedContext(body).messages
    }

    contextBody (body: string): string {
        return this.cachedContext(body).formatted
    }

    protectedFields (body: string): number {
        return this.cachedContext(body).protectedCount
    }

    private cachedContext (body: string): ContextPreview {
        let cached = this.contextCache.get(body)
        if (!cached) {
            let formatted = body
            let messages: ContextMessage[] = []
            try {
                const request = JSON.parse(body)
                formatted = JSON.stringify(request, null, 2)
                if (Array.isArray(request.messages)) {
                    messages = request.messages.map(message => ({
                        label: { system: '系统指令与历史', user: '你的输入', assistant: 'Agent', tool: '工具结果' }[message.role] ?? String(message.role),
                        expanded: message.role !== 'system',
                        text: [typeof message.content === 'string' ? message.content : message.content ? JSON.stringify(message.content, null, 2) : '',
                            Array.isArray(message.tool_calls) ? message.tool_calls.map(call => {
                                let argumentsText = String(call.function?.arguments ?? '')
                                try { argumentsText = JSON.stringify(JSON.parse(argumentsText), null, 2) } catch { /* Preserve incomplete arguments. */ }
                                return `${call.function?.name ?? '工具调用'}\n${argumentsText}`
                            }).join('\n\n') : ''].filter(Boolean).join('\n'),
                    }))
                }
            } catch { /* Keep the submitted text in the complete request view. */ }
            cached = { formatted, messages, protectedCount: (body.match(/__TABBY_SENSITIVE_\d+__|\[REDACTED[^\]]*\]/g) ?? []).length }
            if (this.contextCache.size >= 5) { this.contextCache.delete(this.contextCache.keys().next().value) }
            this.contextCache.set(body, cached)
        }
        return cached
    }

    requestRisk (request: ApprovalRequest): string {
        return commandRiskDescription(this.commands.get(request.id) ?? request.command, request.risk)
    }

    generateCredential (id: string): void {
        const bytes = crypto.getRandomValues(new Uint8Array(32))
        this.values.set(id, Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''))
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

    async submitForm (form: FormRequest, submitted = true): Promise<void> {
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

    stopAgent (): void {
        this.runtime.stopAgent?.()
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
