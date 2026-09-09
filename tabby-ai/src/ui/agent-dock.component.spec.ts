import * as assert from 'node:assert/strict'
import { BehaviorSubject, Subject } from 'rxjs'
import { AgentDockComponent } from './agent-dock.component'
import { AgentInteractionService } from '../agent/interaction.service'
import { AISessionService } from '../session/ai-session.service'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    const fixture = (interactions: AgentInteractionService, connectionId: string) => {
        const runtime: any = {
            id: 'shared-transcript', connectionId, activeRunId: 'run-' + connectionId,
            state: new BehaviorSubject('WAITING_APPROVAL'),
            terminal: new BehaviorSubject({ state: 'prompt' }),
            tab: { profile: { name: connectionId, options: { user: 'tester', host: connectionId + '.example', port: 2222 } }, frontend: { focus: () => undefined } },
        }
        const dock = new AgentDockComponent({} as any, { config: { changed: new Subject() } } as any,
            {} as any, interactions, { markForCheck: () => undefined } as any, { run: (fn: () => void) => fn() } as any)
        dock.runtime = runtime
        dock.ngOnInit()
        const owner = { sessionId: runtime.id, connectionId, runId: runtime.activeRunId }
        return { dock, runtime, owner }
    }
    await test('two SSH docks with the same transcript only show and approve their own requests', async () => {
        const service = new AgentInteractionService()
        const a = fixture(service, 'connection-a'), b = fixture(service, 'connection-b')
        try {
            const pa = service.request({ ...a.owner, command: 'touch /tmp/a', reason: 'A', risk: 'MODIFY', confirmationsRequired: 1 })
            const pb = service.request({ ...b.owner, command: 'touch /tmp/b', reason: 'B', risk: 'DANGEROUS', confirmationsRequired: 2 })
            const ra = a.dock.requests[0], rb = b.dock.requests[0]
            assert.equal(a.dock.requests.length, 1)
            assert.equal(b.dock.requests.length, 1)
            b.dock.edit(ra, 'cross-window edit')
            b.dock.approve(ra)
            b.dock.reject(ra)
            assert.equal(service.resolve(ra.id, { approved: true, command: ra.command }, b.owner), false)
            assert.equal(service.requests.value.length, 2)
            a.dock.edit(ra, 'touch /tmp/edited-a')
            a.dock.approve(ra)
            assert.equal((await pa).command, 'touch /tmp/edited-a')
            assert.equal(b.dock.requests.length, 1)
            b.dock.approve(rb)
            assert.equal(service.requests.value.length, 1)
            b.dock.reject(rb)
            assert.equal((await pb).approved, false)
        } finally { a.dock.ngOnDestroy(); b.dock.ngOnDestroy() }
    })
    await test('password forms, stale runs and disconnected windows cannot submit to another SSH connection', async () => {
        const service = new AgentInteractionService()
        const a = fixture(service, 'connection-a'), b = fixture(service, 'connection-b')
        try {
            const pa = service.requestForm({ ...a.owner, prompt: 'A password', kind: 'password' })
            const pb = service.requestForm({ ...b.owner, prompt: 'B password', kind: 'password' })
            const fa = a.dock.forms[0], fb = b.dock.forms[0]
            b.dock.values.set(fa.id, 'wrong-window-value')
            b.dock.submitForm(fa)
            assert.equal(service.forms.value.length, 2)
            assert.equal(service.resolveForm(fa.id, { submitted: true, value: 'wrong' }, b.owner), false)
            a.dock.values.set(fa.id, 'local-test-secret')
            a.dock.submitForm(fa)
            assert.equal((await pa).value, 'local-test-secret')
            b.dock.values.set(fb.id, 'stale-test-value')
            b.runtime.activeRunId = 'new-run'
            b.runtime.state.next('THINKING')
            assert.equal(b.dock.forms.length, 0)
            assert.equal(b.dock.values.size, 0)
            b.dock.submitForm(fb)
            assert.equal(service.forms.value.length, 1)
            service.cancelRun(b.owner.runId)
            assert.equal((await pb).submitted, false)
            const pc = service.requestForm({ ...b.owner, runId: 'new-run', prompt: 'closing', kind: 'password' })
            const fc = b.dock.forms[0]
            b.runtime.terminal.next({ state: 'closed' })
            b.dock.submitForm(fc)
            assert.equal(service.forms.value.length, 1)
            service.cancelRun('new-run')
            assert.equal((await pc).submitted, false)
        } finally { a.dock.ngOnDestroy(); b.dock.ngOnDestroy() }
    })
    await test('simultaneously restored SSH tabs never share a live history owner or connection id', async () => {
        let created = 0
        const store = {
            createDraft: async () => 'new-' + ++created, list: async () => [{ id: 'restored' }],
            discardDraft: () => undefined, read: async () => [],
        }
        const sessions = new AISessionService(store as any, {} as any)
        const tab = () => ({ aiSessionId: 'restored', profile: { id: 'profile', name: 'SSH', options: { host: 'example', user: 'tester' } } })
        const [a, b] = await Promise.all([sessions.attach(tab() as any), sessions.attach(tab() as any)])
        assert.notEqual(a.id, b.id)
        assert.notEqual(a.connectionId, b.connectionId)
        assert.equal(a.id, 'restored')
        sessions.detach(a.tab)
        sessions.detach(b.tab)
    })
}
