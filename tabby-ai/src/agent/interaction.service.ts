import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import * as crypto from 'crypto'

import { CommandRisk } from '../config/config-schema'

export interface ApprovalRequest {
    id: string
    sessionId: string
    runId: string
    command: string
    reason: string
    risk: CommandRisk
    confirmationsRequired: number
}

export interface ApprovalResponse {
    approved: boolean
    command: string
}

export interface FormRequest {
    id: string
    sessionId: string
    runId: string
    prompt: string
    kind: 'text'|'password'
}

export interface FormResponse {
    submitted: boolean
    value: string
}

@Injectable({ providedIn: 'root' })
export class AgentInteractionService {
    readonly requests = new BehaviorSubject<ApprovalRequest[]>([])
    readonly forms = new BehaviorSubject<FormRequest[]>([])
    private resolvers = new Map<string, (response: ApprovalResponse) => void>()
    private formResolvers = new Map<string, (response: FormResponse) => void>()

    request (value: Omit<ApprovalRequest, 'id'>): Promise<ApprovalResponse> {
        const request = { ...value, id: crypto.randomUUID() }
        return new Promise(resolve => {
            this.resolvers.set(request.id, resolve)
            this.requests.next([...this.requests.value, request])
        })
    }

    resolve (requestId: string, response: ApprovalResponse): void {
        const resolver = this.resolvers.get(requestId)
        if (!resolver) {
            return
        }
        this.resolvers.delete(requestId)
        this.requests.next(this.requests.value.filter(item => item.id !== requestId))
        resolver(response)
    }

    requestForm (value: Omit<FormRequest, 'id'>): Promise<FormResponse> {
        const request = { ...value, id: crypto.randomUUID() }
        return new Promise(resolve => {
            this.formResolvers.set(request.id, resolve)
            this.forms.next([...this.forms.value, request])
        })
    }

    resolveForm (requestId: string, response: FormResponse): void {
        const resolver = this.formResolvers.get(requestId)
        if (!resolver) {
            return
        }
        this.formResolvers.delete(requestId)
        this.forms.next(this.forms.value.filter(item => item.id !== requestId))
        resolver(response)
    }

    cancelRun (runId: string): void {
        for (const request of this.requests.value.filter(item => item.runId === runId)) {
            this.resolve(request.id, { approved: false, command: request.command })
        }
        for (const form of this.forms.value.filter(item => item.runId === runId)) {
            this.resolveForm(form.id, { submitted: false, value: '' })
        }
    }
}
