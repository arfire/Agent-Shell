import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { AISessionService } from './ai-session.service'
import { AISessionStore } from './session-store'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    await test('drafts stay temporary and deletion requires an unused session with no SSH connection', async () => {
        const directory = await fs.promises.mkdtemp(path.resolve('.build-cache/ai-context-test-'))
        const store = new AISessionStore({ directory } as any, { create: () => ({ error: () => undefined, warn: () => undefined }) } as any)
        const sessions = new AISessionService(store, { redact: (value: string) => value } as any)
        const tab: any = { profile: { id: 'qa', name: 'QA', options: { host: 'qa.test', user: 'qa' } } }
        const runtime = await sessions.attach(tab)
        try {
            assert.equal(runtime.historyToRestore, undefined)
            const connectionId = runtime.connectionId
            const first = runtime.id
            await sessions.append(runtime, 'ssh-output', { content: 'welcome' })
            assert.deepEqual(await store.list(), [])
            await sessions.selectContext(runtime)
            assert.ok(store.isRetired(first))
            assert.deepEqual(await store.list(), [])
            await sessions.append(runtime, 'user-ai-input', { content: 'first task' })
            const saved = runtime.id
            runtime.activeRunId = 'running'
            await assert.rejects(sessions.deleteContext(saved), /正在使用/)
            assert.equal((await store.list()).length, 1)
            runtime.activeRunId = undefined
            runtime.locked = true
            await assert.rejects(sessions.deleteContext(saved), /正在使用/)
            runtime.locked = false
            await assert.rejects(sessions.deleteContext(saved), /断开连接/)
            runtime.terminal.next({ ...runtime.terminal.value, state: 'closed' })
            const releaseOpen = sessions.beginOpen(saved)
            await assert.rejects(sessions.deleteContext(saved), /正在连接/)
            releaseOpen()
            tab.session = { open: true }
            await assert.rejects(sessions.deleteContext(saved), /断开连接/)
            tab.session.open = false
            await sessions.deleteContext(saved)
            assert.equal(runtime.tab, tab)
            assert.equal(runtime.connectionId, connectionId)
            assert.equal(sessions.get(tab), runtime)
            assert.notEqual(runtime.id, saved)
            assert.equal(tab.aiSessionId, runtime.id)
            assert.deepEqual(runtime.events.value, [])
            assert.deepEqual(await store.list(), [])
            await sessions.appendToContext(runtime, saved, 'ssh-output', { content: 'late output' })
            assert.deepEqual(runtime.events.value, [])
            await sessions.append(runtime, 'user-ai-input', { content: 'next task' })
            assert.equal((await store.list(false))[0].title, 'next task')
            await sessions.selectContext(runtime)
            const draft = runtime.id
            sessions.detach(tab)
            assert.ok(store.isRetired(draft))
        } finally { sessions.detach(tab); store.ngOnDestroy() }
    })
}
