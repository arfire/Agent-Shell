import * as assert from 'node:assert/strict'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, fixture: () => Promise<any>): Promise<void> {
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
