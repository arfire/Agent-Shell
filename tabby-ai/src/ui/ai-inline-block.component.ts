import { Component, Input, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'

import { AgentInteractionService, ApprovalRequest, FormRequest } from '../agent/interaction.service'
import { AISessionRuntime } from '../session/ai-session.service'
import { SessionEvent } from '../session/session-event'

@Component({
    selector: 'tabby-ai-inline-block',
    templateUrl: './ai-inline-block.component.pug',
    styleUrls: ['./ai-inline-block.component.scss'],
})
export class AIInlineBlockComponent implements OnInit, OnDestroy {
    @Input() runtime: AISessionRuntime
    @Input() runId: string
    @Input() stopHandler?: () => void

    events: SessionEvent[] = []
    requests: ApprovalRequest[] = []
    forms: FormRequest[] = []
    liveText = ''
    state = 'IDLE'
    editedCommands = new Map<string, string>()
    confirmations = new Set<string>()
    formValues = new Map<string, string>()

    private subscriptions: Subscription[] = []

    constructor (
        private interactions: AgentInteractionService,
    ) { }

    ngOnInit (): void {
        this.subscriptions.push(
            this.runtime.events.subscribe(events => {
                this.events = events.filter(event => event.runId === this.runId)
                if (this.runtime.activeRunId !== this.runId) {
                    const lastState = [...this.events].reverse().find(event => event.type === 'agent-state')
                    this.state = (lastState?.data as any)?.state ?? 'DONE'
                }
            }),
            this.runtime.liveText.subscribe(text => {
                this.liveText = this.runtime.activeRunId === this.runId ? text : ''
            }),
            this.runtime.state.subscribe(state => {
                if (this.runtime.activeRunId === this.runId) {
                    this.state = state
                }
            }),
            this.interactions.requests.subscribe(requests => {
                this.requests = requests.filter(request => request.runId === this.runId)
                for (const request of this.requests) {
                    if (!this.editedCommands.has(request.id)) {
                        this.editedCommands.set(request.id, request.command)
                    }
                }
            }),
            this.interactions.forms.subscribe(forms => {
                this.forms = forms.filter(form => form.runId === this.runId)
                for (const form of this.forms) {
                    if (!this.formValues.has(form.id)) {
                        this.formValues.set(form.id, '')
                    }
                }
            }),
        )
    }

    ngOnDestroy (): void {
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
    }

    getMessages (): SessionEvent[] {
        return this.events.filter(event => ['ai-message', 'error'].includes(event.type))
    }

    getCommands (): SessionEvent[] {
        return this.events.filter(event => event.type === 'ai-command')
    }

    getCommand (request: ApprovalRequest): string {
        return this.editedCommands.get(request.id) ?? request.command
    }

    setCommand (request: ApprovalRequest, value: string): void {
        this.editedCommands.set(request.id, value)
        this.confirmations.delete(request.id)
    }

    approve (request: ApprovalRequest): void {
        if (request.confirmationsRequired > 1 && !this.confirmations.has(request.id)) {
            this.confirmations.add(request.id)
            return
        }
        this.interactions.resolve(request.id, {
            approved: true,
            command: this.getCommand(request),
        })
    }

    reject (request: ApprovalRequest): void {
        this.interactions.resolve(request.id, {
            approved: false,
            command: this.getCommand(request),
        })
    }

    stop (): void {
        this.stopHandler?.()
    }

    submitForm (form: FormRequest): void {
        this.interactions.resolveForm(form.id, {
            submitted: true,
            value: this.formValues.get(form.id) ?? '',
        })
        this.formValues.delete(form.id)
    }

    isActive (): boolean {
        return !['IDLE', 'DONE', 'FAILED', 'CANCELLED'].includes(this.state)
    }
}
