import * as assert from 'node:assert/strict'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, fixture: () => Promise<any>): Promise<void> {
    await test('Shell keystrokes pass through immediately without repeated remote state notifications', async () => {
        const f = await fixture()
        try {
            f.integration.mode.next('shell')
            const states: string[] = []
            const subscription = f.integration.state.subscribe((state: string) => states.push(state))
            states.length = 0
            const text = 'echo 输入测试'.repeat(20)
            for (const character of text) { f.input.feedFromTerminal(Buffer.from(character)) }
            assert.equal(f.sent.join(''), text)
            assert.deepEqual(states, ['remote'])
            assert.deepEqual(f.agent, [])
            assert.equal(f.input.hasInput, false)
            subscription.unsubscribe()
        } finally { f.close() }
    })
    await test('rapid printable input appends linearly without repainting the accumulated draft', async () => {
        const f = await fixture()
        try {
            const writes: string[] = []
            const write = f.runtime.tab.write
            f.runtime.tab.write = (text: string) => { writes.push(text); return write(text) }
            const draft = '中文输入😀abcdef'.repeat(12)
            for (const character of draft) { f.input.feedFromTerminal(Buffer.from(character)) }
            await f.input.settled()
            assert.deepEqual(f.sent, [])
            assert.ok(writes.join('').length < draft.length * 2, 'Each keystroke repainted old text')
            await f.type('\x7f\x1b[H')
            await f.type('开头')
            f.input.submit('agent')
            await f.input.settled()
            assert.deepEqual(f.agent, ['开头' + draft.slice(0, -1)])
        } finally { f.close() }
    })
    await test('editing Chinese drafts with arrows, Home, Delete and paste never transfers to SSH', async () => {
        const f = await fixture()
        try {
            await f.type('\x1b[D\x01\x1b[F')
            assert.deepEqual(f.sent, [])
            await f.type('帮我检查配错置')
            await f.type('\x1b[D\x7f')
            await f.type('\x1b[H')
            f.input.pasteText('请'); await f.input.settled()
            await f.type('\x1b[F\t\x1b[A\x1b[B\x12')
            assert.deepEqual(f.sent, [])
            f.input.submit('agent'); await f.input.settled()
            assert.deepEqual(f.agent, ['请帮我检查配置\t'])
            assert.deepEqual(f.sent, [])
        } finally { f.close() }
    })
    await test('multiline and emoji edits preserve full draft and explicit Shell sends edited text once', async () => {
        const f = await fixture()
        try {
            f.input.pasteText('第一行\n😀末尾'); await f.input.settled()
            await f.type('\x01\x1b[3~')
            await f.type('\x1b[A\x01')
            f.input.pasteText('开头'); await f.input.settled()
            assert.deepEqual(f.sent, [])
            f.input.submit('shell'); await f.input.settled()
            assert.deepEqual(f.sent, ['\x1b[200~开头第一行\n末尾\x1b[201~\r'])
        } finally { f.close() }
    })
}
