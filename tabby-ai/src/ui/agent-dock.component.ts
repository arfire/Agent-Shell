import { ChangeDetectorRef, Component, Input, NgZone, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'

import { AISessionRuntime } from '../session/ai-session.service'
import { AgentInteractionService, ApprovalRequest, FormRequest } from '../agent/interaction.service'
import { TerminalControllerService } from '../terminal/terminal-controller.service'

@Component({
    selector: 'ash-agent-dock',
    templateUrl: './agent-dock.component.pug',
    styleUrls: ['./agent-dock.component.scss'],
})
export class AgentDockComponent implements OnInit, OnDestroy {
    @Input() runtime: AISessionRuntime
    requests: ApprovalRequest[] = []
    forms: FormRequest[] = []
    commands = new Map<string, string>()
    values = new Map<string, string>()
    confirmed = new Set<string>()
    private subscriptions: Subscription[] = []

    constructor (
        public terminal: TerminalControllerService,
        private interactions: AgentInteractionService,
        private changeDetector: ChangeDetectorRef,
        private zone: NgZone,
    ) { }

    ngOnInit (): void {
        this.subscriptions.push(
            this.runtime.terminal.subscribe(() => this.refresh()),
            this.runtime.state.subscribe(() => this.refresh()),
            this.interactions.requests.subscribe(requests => {
                this.requests = requests.filter(request => request.sessionId === this.runtime.id)
                const ids = new Set(this.requests.map(request => request.id))
                for (const id of this.commands.keys()) {
                    if (!ids.has(id)) { this.commands.delete(id); this.confirmed.delete(id) }
                }
                for (const request of this.requests) {
                    if (!this.commands.has(request.id)) { this.commands.set(request.id, request.command) }
                }
                this.refresh()
            }),
            this.interactions.forms.subscribe(forms => {
                this.forms = forms.filter(form => form.sessionId === this.runtime.id)
                const ids = new Set(this.forms.map(form => form.id))
                for (const id of this.values.keys()) {
                    if (!ids.has(id)) { this.values.delete(id) }
                }
                this.refresh()
            }),
        )
    }

    ngOnDestroy (): void {
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.values.clear()
        this.commands.clear()
    }

    private refresh (): void {
        this.zone.run(() => this.changeDetector.markForCheck())
    }

    get statusLabel (): string {
        return ({ QUEUED: '等待中', THINKING: '思考中', EXECUTING: '执行中', OBSERVING: '检查结果',
            WAITING_APPROVAL: '等待审批', WAITING_INTERACTION: '等待输入', DONE: '已完成', CANCELLED: '已停止', FAILED: '失败',
        } as Partial<Record<string, string>>)[this.runtime.state.value] ?? ''
    }

    edit (request: ApprovalRequest, value: string): void {
        this.commands.set(request.id, value)
        this.confirmed.delete(request.id)
    }

    approve (request: ApprovalRequest): void {
        if (request.confirmationsRequired > 1 && !this.confirmed.has(request.id)) {
            this.confirmed.add(request.id)
            return
        }
        this.interactions.resolve(request.id, { approved: true, command: this.commands.get(request.id) ?? request.command })
        this.runtime.tab.frontend?.focus()
    }

    reject (request: ApprovalRequest): void {
        this.interactions.resolve(request.id, { approved: false, command: request.command })
        this.runtime.tab.frontend?.focus()
    }

    submitForm (form: FormRequest, submitted = true): void {
        const value = submitted ? this.values.get(form.id) ?? '' : ''
        this.values.delete(form.id)
        this.interactions.resolveForm(form.id, { submitted, value })
        this.runtime.tab.frontend?.focus()
    }

    async toggleMode (): Promise<void> {
        await this.terminal.setMode(this.runtime, this.runtime.terminal.value.mode === 'agent' ? 'shell' : 'agent')
        this.runtime.tab.frontend?.focus()
    }
}
