import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnDestroy, OnInit, QueryList, ViewChild, ViewChildren } from '@angular/core'
import { Subscription } from 'rxjs'

import { AgentInteractionService, ApprovalRequest, FormRequest } from '../agent/interaction.service'
import { AISessionRuntime } from '../session/ai-session.service'
import { SessionEvent } from '../session/session-event'

const markedModule = require('marked') as {
    parse?: (source: string, options?: Record<string, unknown>) => string
    marked?: (source: string, options?: Record<string, unknown>) => string
}

function parsePixels (value: string): number {
    return Number.parseFloat(value) || 0
}

function normalizeConfirmationsRequired (value: number|undefined): number {
    return Math.max(1, typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1)
}

@Component({
    selector: 'tabby-ai-inline-block',
    templateUrl: './ai-inline-block.component.pug',
    styleUrls: ['./ai-inline-block.component.scss'],
})
export class AIInlineBlockComponent implements OnInit, AfterViewInit, OnDestroy {
    @Input() runtime: AISessionRuntime
    @Input() runId: string
    @Input() stopHandler?: () => void
    @Input() preferredHeightHandler?: (height: number) => void
    @Input() firstEventSeq = 0

    events: SessionEvent[] = []
    requests: ApprovalRequest[] = []
    forms: FormRequest[] = []
    liveText = ''
    state = 'IDLE'
    editedCommands = new Map<string, string>()
    confirmations = new Set<string>()
    formValues = new Map<string, string>()
    collapsed = false

    @ViewChild('header') private headerElement?: ElementRef<HTMLElement>
    @ViewChild('body') private bodyElement?: ElementRef<HTMLElement>
    @ViewChild('content') private contentElement?: ElementRef<HTMLElement>
    @ViewChildren('commandInput') private commandInputs: QueryList<ElementRef<HTMLTextAreaElement>>
    @ViewChildren('formInput') private formInputs: QueryList<ElementRef<HTMLInputElement>>

    private subscriptions: Subscription[] = []
    private interrupted = false
    private layoutObserver?: ResizeObserver
    private layoutFrame?: number
    private renderFrame?: number
    private destroyed = false
    private messageHTML = new Map<string, string>()
    private liveMarkdown = { source: '', html: '' }

    constructor (
        private interactions: AgentInteractionService,
        private hostElement: ElementRef<HTMLElement>,
        private changeDetector: ChangeDetectorRef,
    ) { }

    ngOnInit (): void {
        this.subscriptions.push(
            this.runtime.events.subscribe(events => {
                if (this.interrupted) {
                    return
                }
                this.events = events.filter(event => event.runId === this.runId && event.seq >= this.firstEventSeq)
                if (this.runtime.activeRunId !== this.runId) {
                    const lastState = [...this.events].reverse().find(event => event.type === 'agent-state')
                    this.state = (lastState?.data as any)?.state ?? 'DONE'
                }
                this.queueRender()
            }),
            this.runtime.liveText.subscribe(text => {
                if (this.interrupted) {
                    return
                }
                this.liveText = this.runtime.activeRunId === this.runId ? text : ''
                this.queueRender()
            }),
            this.runtime.state.subscribe(state => {
                if (this.interrupted) {
                    return
                }
                if (this.runtime.activeRunId === this.runId) {
                    this.state = state
                }
                this.queueRender()
            }),
            this.interactions.requests.subscribe(requests => {
                if (this.interrupted) {
                    return
                }
                this.requests = requests.filter(request => request.runId === this.runId)
                for (const request of this.requests) {
                    if (!this.editedCommands.has(request.id)) {
                        this.editedCommands.set(request.id, request.command)
                    }
                }
                this.queueRender()
                this.focusCommandInput()
            }),
            this.interactions.forms.subscribe(forms => {
                if (this.interrupted) {
                    return
                }
                this.forms = forms.filter(form => form.runId === this.runId)
                for (const form of this.forms) {
                    if (!this.formValues.has(form.id)) {
                        this.formValues.set(form.id, '')
                    }
                }
                this.queueRender()
                this.focusFormInput()
            }),
        )
    }

    ngAfterViewInit (): void {
        this.subscriptions.push(this.commandInputs.changes.subscribe(() => this.focusCommandInput()))
        this.subscriptions.push(this.formInputs.changes.subscribe(() => this.focusFormInput()))
        this.layoutObserver = new ResizeObserver(() => this.refreshLayout())
        this.layoutObserver.observe(this.headerElement!.nativeElement)
        this.layoutObserver.observe(this.contentElement!.nativeElement)
        this.focusCommandInput()
        this.focusFormInput()
        this.refreshLayout()
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.layoutObserver?.disconnect()
        if (this.layoutFrame !== undefined) {
            cancelAnimationFrame(this.layoutFrame)
        }
        if (this.renderFrame !== undefined) {
            cancelAnimationFrame(this.renderFrame)
        }
    }

    getMessages (): SessionEvent[] {
        return this.events.filter(event => ['ai-message', 'error'].includes(event.type))
    }

    getCommands (): SessionEvent[] {
        return this.events.filter(event => event.type === 'ai-command')
    }

    getMessageHTML (event: SessionEvent): string {
        const source = String((event.data as any)?.content ?? '')
        const cached = this.messageHTML.get(event.id)
        if (cached !== undefined) {
            return cached
        }
        const html = this.renderMarkdown(source)
        this.messageHTML.set(event.id, html)
        return html
    }

    getLiveTextHTML (): string {
        if (this.liveMarkdown.source !== this.liveText) {
            this.liveMarkdown = {
                source: this.liveText,
                html: this.renderMarkdown(this.liveText),
            }
        }
        return this.liveMarkdown.html
    }

    getCommand (request: ApprovalRequest): string {
        return this.editedCommands.get(request.id) ?? request.command
    }

    getCommandRisk (event: SessionEvent): string {
        return String((event.data as any)?.risk ?? '')
    }

    getCommandReason (event: SessionEvent): string {
        return String((event.data as any)?.reason ?? '')
    }

    getCommandContent (event: SessionEvent): string {
        return String((event.data as any)?.command ?? '')
    }

    getRequestReason (request: ApprovalRequest): string {
        return request.reason || 'Review command before execution'
    }

    getRequestConfirmationsRequired (request: ApprovalRequest): number {
        return normalizeConfirmationsRequired(request.confirmationsRequired)
    }

    isAwaitingFinalConfirmation (request: ApprovalRequest): boolean {
        return this.getRequestConfirmationsRequired(request) > 1 && this.confirmations.has(request.id)
    }

    updateCommandFromEvent (request: ApprovalRequest, event: Event): void {
        this.setCommand(request, (event.target as HTMLTextAreaElement).value)
    }

    stopTerminalEvent (event: Event): void {
        event.stopPropagation()
    }

    setCommand (request: ApprovalRequest, value: string): void {
        this.editedCommands.set(request.id, value)
        this.confirmations.delete(request.id)
        this.queueRender()
    }

    approve (request: ApprovalRequest): void {
        if (this.getRequestConfirmationsRequired(request) > 1 && !this.confirmations.has(request.id)) {
            this.confirmations.add(request.id)
            this.queueRender()
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

    stop (event?: MouseEvent): void {
        event?.preventDefault()
        event?.stopPropagation()
        this.stopHandler?.()
    }

    toggleCollapsed (event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.collapsed = !this.collapsed
        this.refreshLayout()
    }

    interrupt (): void {
        if (this.interrupted) {
            return
        }
        this.interrupted = true
        this.events = this.runtime.events.value.filter(event =>
            event.runId === this.runId && event.seq >= this.firstEventSeq)
        this.liveText = this.runtime.activeRunId === this.runId ? this.runtime.liveText.value : this.liveText
        this.requests = []
        this.forms = []
        this.stopHandler = undefined
        this.state = 'INTERRUPTED'
    }

    finish (): void {
        if (this.interrupted) {
            return
        }
        this.interrupted = true
        this.events = this.runtime.events.value.filter(event =>
            event.runId === this.runId && event.seq >= this.firstEventSeq)
        this.liveText = this.runtime.activeRunId === this.runId ? this.runtime.liveText.value : this.liveText
        this.requests = []
        this.forms = []
        this.stopHandler = undefined
        const lastState = [...this.events].reverse().find(event => event.type === 'agent-state')
        this.state = (lastState?.data as any)?.state ?? this.state
    }

    onWheel (event: WheelEvent): void {
        const element = event.currentTarget as HTMLElement
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                ? element.clientHeight
                : 1
        const deltaY = event.deltaY * unit
        const deltaX = event.deltaX * unit
        const canScrollVertically = deltaY < 0
            ? element.scrollTop > 0
            : deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1
        const canScrollHorizontally = deltaX < 0
            ? element.scrollLeft > 0
            : deltaX > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1
        if (!canScrollVertically && !canScrollHorizontally) {
            return
        }
        element.scrollTop += deltaY
        element.scrollLeft += deltaX
        event.preventDefault()
        event.stopPropagation()
    }

    refreshLayout (immediate = false): void {
        const handler = this.preferredHeightHandler
        const header = this.headerElement?.nativeElement
        const body = this.bodyElement?.nativeElement
        const content = this.contentElement?.nativeElement
        if (!handler || !header || !body || !content) {
            return
        }
        if (this.layoutFrame !== undefined) {
            cancelAnimationFrame(this.layoutFrame)
        }
        const update = (): void => {
            this.layoutFrame = undefined
            const hostStyle = getComputedStyle(this.hostElement.nativeElement)
            const bodyStyle = getComputedStyle(body)
            const hostSpacing = parsePixels(hostStyle.paddingTop) + parsePixels(hostStyle.paddingBottom)
            const bodySpacing = parsePixels(bodyStyle.paddingTop) + parsePixels(bodyStyle.paddingBottom)
            const borders = 2
            const bodyHeight = this.collapsed ? 0 : content.scrollHeight + bodySpacing
            handler(header.offsetHeight + bodyHeight + hostSpacing + borders)
        }
        if (immediate) {
            update()
        } else {
            this.layoutFrame = requestAnimationFrame(update)
        }
    }

    submitForm (form: FormRequest): void {
        this.interactions.resolveForm(form.id, {
            submitted: true,
            value: this.formValues.get(form.id) ?? '',
        })
        this.formValues.delete(form.id)
    }

    isActive (): boolean {
        return !['IDLE', 'DONE', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(this.state)
    }

    private focusFormInput (): void {
        if (this.interrupted || !this.forms.length) {
            return
        }
        setTimeout(() => {
            if (this.interrupted || !this.formInputs.length) {
                return
            }
            const input = this.formInputs.last.nativeElement
            input.focus()
            const end = input.value.length
            input.setSelectionRange(end, end)
        })
    }

    private focusCommandInput (): void {
        if (this.interrupted || !this.requests.length) {
            return
        }
        setTimeout(() => {
            if (this.interrupted || !this.commandInputs.length) {
                return
            }
            const input = this.commandInputs.last.nativeElement
            input.focus()
            const end = input.value.length
            input.setSelectionRange(end, end)
        })
    }

    private renderMarkdown (source: string): string {
        const parser = markedModule.parse ?? markedModule.marked
        const normalized = this.normalizeMarkdown(source)
        return parser ? parser(normalized, { breaks: true, gfm: true }) : normalized
    }

    /**
     * Some OpenAI-compatible gateways escape Markdown delimiters even though
     * the response body is already decoded JSON. Recover those delimiters and
     * split compact numbered lists so GFM can render the intended structure.
     */
    private normalizeMarkdown (source: string): string {
        let normalized = source.replace(/\r\n?/g, '\n')
        const escapedDelimiters = normalized.match(/\\[*_`~\[\]]/g)?.length ?? 0
        if (escapedDelimiters >= 2) {
            normalized = normalized.replace(/\\([*_`~\[\]])/g, '$1')
        }
        return normalized.replace(/([^\n])\s+(\d+\.\s+(?=(?:\*\*|__|`)))/g, '$1\n$2')
    }

    private queueRender (): void {
        if (this.destroyed || this.renderFrame !== undefined) {
            return
        }
        this.renderFrame = requestAnimationFrame(() => {
            this.renderFrame = undefined
            if (this.destroyed) {
                return
            }
            this.changeDetector.detectChanges()
            this.refreshLayout()
        })
    }
}
