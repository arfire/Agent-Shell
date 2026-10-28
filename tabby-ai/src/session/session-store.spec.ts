import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { AISessionStore } from './session-store'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    const directory = await fs.promises.mkdtemp(path.resolve('.build-cache/ai-store-test-'))
    const log = { create: () => ({ error: () => undefined, warn: () => undefined }) }
    const create = (name: string): AISessionStore => new AISessionStore({ directory: path.join(directory, name) } as any, log as any)
    await test('SSH-only drafts stay in memory, retain bounded context and persist on the first Agent message', async () => {
        const store = create('draft')
        try {
            const id = await store.createDraft({ host: 'draft.test' })
            for (let i = 0; i < 120; i++) { await store.append(id, 'ssh-output', { content: `line ${i}` }) }
            await store.retrySaving()
            assert.deepEqual(await store.list(), [])
            assert.equal(fs.existsSync(path.join(directory, 'draft', 'sessions', `${id}.jsonl`)), false)
            assert.equal(store.persistence.value.pending, 0)
            assert.ok((await store.read(id)).length <= 100)
            await Promise.all([
                store.append(id, 'user-ai-input', { content: '检查状态' }),
                store.append(id, 'ssh-output', { content: 'concurrent output' }),
            ])
            const entries = await store.list(false)
            assert.equal(entries.length, 1)
            assert.equal(entries[0].title, '检查状态')
            assert.equal(entries[0].host, 'draft.test')
            const events = await store.read(id)
            assert.ok(events.some(e => (e.data as any).content === 'line 119'))
            assert.equal(events.filter(e => e.type === 'user-ai-input').length, 1)
            assert.equal(new Set(events.map(e => e.seq)).size, events.length)
            const discarded = await store.createDraft()
            const late = store.append(discarded, 'ssh-output', { content: 'late' })
            store.discardDraft(discarded)
            await late
            assert.equal(fs.existsSync(path.join(directory, 'draft', 'sessions', `${discarded}.jsonl`)), false)
        } finally { store.ngOnDestroy() }
    })
    await test('deletion removes history, rejects delayed writes and survives stale index recovery', async () => {
        let store = create('delete')
        const base = path.join(directory, 'delete')
        const id = await store.createSession({ host: 'delete.test' })
        await store.append(id, 'user-ai-input', { content: 'delete me' })
        await store.retrySaving()
        const oldIndex = await fs.promises.readFile(path.join(base, 'sessions.json'))
        try {
            await Promise.all([store.append(id, 'ssh-output', { content: 'in flight' }), store.deleteSession(id)])
            await store.append(id, 'ssh-output', { content: 'late' })
            await store.retrySaving()
            assert.deepEqual(await store.list(), [])
            assert.equal(fs.existsSync(path.join(base, 'sessions', `${id}.jsonl`)), false)
            assert.deepEqual(await store.read(id), [])
            store.ngOnDestroy()
            await fs.promises.writeFile(path.join(base, 'sessions.json'), oldIndex)
            store = create('delete')
            assert.deepEqual(await store.list(), [])
            await store.append(id, 'user-ai-input', { content: 'stale writer' })
            assert.equal(fs.existsSync(path.join(base, 'sessions', `${id}.jsonl`)), false)
        } finally { store.ngOnDestroy() }
    })
    await test('legacy SSH-only histories remain stored but are hidden from conversation lists', async () => {
        let store = create('empty-history')
        const empty = await store.createSession()
        await store.append(empty, 'ssh-output', { content: 'welcome' })
        const active = await store.createSession()
        await store.append(active, 'user-ai-input', { content: 'hello' })
        await store.retrySaving()
        store.ngOnDestroy()
        store = create('empty-history')
        try {
            assert.equal((await store.list()).length, 2)
            assert.deepEqual((await store.list(false)).map(entry => entry.id), [active])
            assert.ok((await store.read(empty)).length)
        } finally { store.ngOnDestroy() }
    })
    await test('failed append retains data, retries in order and does not block later history reads', async () => {
        const store = create('retry')
        const id = await store.createSession({ host: 'example.test', user: 'qa', profileId: 'qa' })
        const append = fs.promises.appendFile
        try {
            fs.promises.appendFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
            const first = await store.append(id, 'ssh-output', { content: 'one' })
            const second = await store.append(id, 'ssh-output', { content: 'two' })
            assert.equal(store.persistence.value.pending, 2)
            assert.match(store.persistence.value.error, /磁盘空间/)
            assert.deepEqual((await store.read(id)).slice(-2).map(e => e.id), [first.id, second.id])
            fs.promises.appendFile = append
            await store.retrySaving()
            assert.equal(store.persistence.value.pending, 0)
            assert.equal(store.persistence.value.error, '')
            const third = await store.append(id, 'ssh-output', { content: 'three' })
            assert.deepEqual((await store.read(id)).slice(-3).map(e => e.id), [first.id, second.id, third.id])
        } finally { fs.promises.appendFile = append; store.ngOnDestroy() }
    })
    await test('ambiguous append completion never duplicates events, partial writes cannot swallow the next event', async () => {
        const store = create('partial')
        const id = await store.createSession()
        const append = fs.promises.appendFile
        try {
            fs.promises.appendFile = async (...args: any[]) => {
                await (append as any)(...args)
                throw new Error('completion lost')
            }
            const full = await store.append(id, 'ai-message', { content: 'complete' })
            fs.promises.appendFile = append
            await store.retrySaving()
            assert.equal((await store.read(id)).filter(e => e.id === full.id).length, 1)
            fs.promises.appendFile = async (file: any, data: any) => {
                await append(file, String(data).slice(0, 25), 'utf8')
                throw new Error('partial disk write')
            }
            const partial = await store.append(id, 'ai-message', { content: 'partial' })
            fs.promises.appendFile = append
            await store.retrySaving()
            const next = await store.append(id, 'ssh-output', { content: 'next' })
            assert.deepEqual((await store.read(id)).slice(-2).map(e => e.id), [partial.id, next.id])
        } finally { fs.promises.appendFile = append; store.ngOnDestroy() }
    })
    await test('damaged or missing index rebuilds names, server association and sequence from journals', async () => {
        let store = create('index')
        const id = await store.createSession({ profileId: 'first', host: 'first.test', user: 'qa', port: 2222 })
        await store.rename(id, '我的排障记录')
        await store.associate(id, { profileId: 'second', host: 'second.test', user: 'qa', port: 22 })
        const last = await store.append(id, 'ai-message', { content: 'preserved' })
        await store.retrySaving()
        store.ngOnDestroy()
        const base = path.join(directory, 'index')
        await fs.promises.writeFile(path.join(base, 'sessions.json'), '{broken', 'utf8')
        store = create('index')
        try {
            const entries = await store.list()
            assert.equal(entries[0].title, '我的排障记录')
            assert.equal(entries[0].host, 'second.test')
            assert.ok((await fs.promises.readdir(base)).some(file => file.startsWith('sessions.json.corrupt-')))
            assert.equal(store.persistence.value.recovered, 1)
            assert.ok((await store.append(id, 'ai-message', { content: 'after recovery' })).seq > last.seq)
            await store.retrySaving()
        } finally { store.ngOnDestroy() }
        // A missing index and a torn final record from a crash.
        await fs.promises.rename(path.join(base, 'sessions.json'), path.join(base, 'saved-index.json'))
        await fs.promises.appendFile(path.join(base, 'sessions', `${id}.jsonl`), '{incomplete', 'utf8')
        store = create('index')
        try {
            assert.equal((await store.list())[0].profileId, 'second')
            const event = await store.append(id, 'ai-message', { content: 'after crash' })
            assert.equal((await store.read(id)).at(-1)?.id, event.id)
            await store.retrySaving()
        } finally { store.ngOnDestroy() }
    })
    await test('legacy unindexed journals remain discoverable and malformed entries do not hide good ones', async () => {
        const base = path.join(directory, 'legacy')
        await fs.promises.mkdir(path.join(base, 'sessions'), { recursive: true })
        const time = new Date().toISOString()
        await fs.promises.writeFile(path.join(base, 'sessions.json'), JSON.stringify([null, { id: '../invalid' }]))
        await fs.promises.writeFile(path.join(base, 'sessions', 'legacy.jsonl'), JSON.stringify({
            version: 1, id: 'event', sessionId: 'legacy', seq: 123, time, type: 'user-ai-input', data: { content: '旧任务' },
        }) + '\n')
        const store = create('legacy')
        try {
            assert.equal((await store.list())[0].title, '旧任务')
            assert.equal((await store.list())[0].host, undefined)
            assert.equal((await store.append('legacy', 'ai-message', { content: 'continued' })).seq, 124)
        } finally { store.ngOnDestroy() }
    })
    await test('index write failure is visible and manual retry clears it without losing journal data', async () => {
        const store = create('index-write')
        const id = await store.createSession()
        const rename = fs.promises.rename
        try {
            fs.promises.rename = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
            await store.rename(id, '名称')
            assert.match(store.persistence.value.error, /写入权限/)
            fs.promises.rename = rename
            await store.retrySaving()
            assert.equal(store.persistence.value.error, '')
            assert.equal((await store.list())[0].title, '名称')
        } finally { fs.promises.rename = rename; store.ngOnDestroy() }
    })
    await test('automatic retry recovers an interrupted write without another user action', async () => {
        const store = create('automatic')
        const id = await store.createSession()
        const append = fs.promises.appendFile
        try {
            fs.promises.appendFile = async () => { throw new Error('temporary failure') }
            await store.append(id, 'ssh-output', { content: 'retry me' })
            fs.promises.appendFile = append
            const until = Date.now() + 5500
            while (store.persistence.value.pending && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 100)) }
            assert.equal(store.persistence.value.pending, 0)
            assert.equal(store.persistence.value.error, '')
            assert.equal((await store.read(id)).at(-1)?.type, 'ssh-output')
        } finally { fs.promises.appendFile = append; store.ngOnDestroy() }
    })
    await test('startup storage failure never overwrites an unread index with an empty list', async () => {
        const base = path.join(directory, 'startup')
        await fs.promises.mkdir(path.join(base, 'sessions'), { recursive: true })
        const original = JSON.stringify([{ id: 'existing', title: '保留', createdAt: '2026-01-01', updatedAt: '2026-01-01', nextSeq: 1 }])
        await fs.promises.writeFile(path.join(base, 'sessions.json'), original)
        const mkdir = fs.promises.mkdir
        let store: AISessionStore|undefined = undefined
        try {
            fs.promises.mkdir = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
            store = create('startup')
            await store.list()
            assert.ok(store.persistence.value.error)
            assert.equal(await fs.promises.readFile(path.join(base, 'sessions.json'), 'utf8'), original)
            fs.promises.mkdir = mkdir
            await store.retrySaving()
            assert.equal((await store.list())[0].title, '保留')
            assert.equal(store.persistence.value.error, '')
        } finally { fs.promises.mkdir = mkdir; store?.ngOnDestroy() }
    })
}
