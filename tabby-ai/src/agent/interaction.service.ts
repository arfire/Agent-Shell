import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import * as crypto from 'crypto'

import { CommandRisk } from '../config/config-schema'

export interface InteractionOwner {
    sessionId: string
    connectionId: string
    runId: string
}

function sameOwner (request: InteractionOwner, owner: InteractionOwner): boolean {
    return !!owner.connectionId && !!owner.runId && request.connectionId === owner.connectionId &&
        request.runId === owner.runId && request.sessionId === owner.sessionId
}

export interface ApprovalRequest extends InteractionOwner {
    id: string
    command: string
    reason: string
    risk: CommandRisk
    confirmationsRequired: number
}

export interface ApprovalResponse {
    approved: boolean
    command: string
}

export interface FormRequest extends InteractionOwner {
    id: string
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

    resolve (requestId: string, response: ApprovalResponse, owner: InteractionOwner): boolean {
        const request = this.requests.value.find(item => item.id === requestId)
        if (!request || !sameOwner(request, owner)) { return false }
        const resolver = this.resolvers.get(requestId)
        if (!resolver) {
            return false
        }
        this.resolvers.delete(requestId)
        this.requests.next(this.requests.value.filter(item => item.id !== requestId))
        resolver(response)
        return true
    }

    requestForm (value: Omit<FormRequest, 'id'>): Promise<FormResponse> {
        const request = { ...value, id: crypto.randomUUID() }
        return new Promise(resolve => {
            this.formResolvers.set(request.id, resolve)
            this.forms.next([...this.forms.value, request])
        })
    }

    resolveForm (requestId: string, response: FormResponse, owner: InteractionOwner): boolean {
        const request = this.forms.value.find(item => item.id === requestId)
        if (!request || !sameOwner(request, owner)) { return false }
        const resolver = this.formResolvers.get(requestId)
        if (!resolver) {
            return false
        }
        this.formResolvers.delete(requestId)
        this.forms.next(this.forms.value.filter(item => item.id !== requestId))
        resolver(response)
        return true
    }

    cancelRun (runId: string): void {
        for (const request of this.requests.value.filter(item => item.runId === runId)) {
            this.resolve(request.id, { approved: false, command: request.command }, request)
        }
        for (const form of this.forms.value.filter(item => item.runId === runId)) {
            this.resolveForm(form.id, { submitted: false, value: '' }, form)
        }
    }
}
