import * as assert from 'node:assert/strict'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, fixture: () => Promise<any>): Promise<void> {
    await test('empty Enter reaches SSH without writing a command history event', async () => {
        const f = await fixture()
        try {
            await f.type('\r')
            assert.deepEqual(f.sent, ['\r'])
            assert.deepEqual(f.events, [])
            assert.deepEqual(f.agent, [])
        } finally { f.close() }
    })
    await test('split SSH output redraws the draft once without inserting an empty row', async () => {
        const f = await fixture()
        try {
            await f.type('正在输入')
            f.input.feedFromSession(Buffer.from('back'))
            f.input.feedFromSession(Buffer.from('ground\r'))
            f.input.feedFromSession(Buffer.from('\n'))
            await f.input.settled()
            const buffer = f.frontend.xterm.buffer.active
            assert.equal(buffer.getLine(0).translateToString(true), '$ background')
            assert.equal(buffer.getLine(1).translateToString(true), '$ 正在输入')
            assert.equal(buffer.cursorY, 1)
            assert.deepEqual(f.sent, [])
        } finally { f.close() }
    })
    await test('SSH chunks preserve order when draft redraw is pending and prompt state changes', async () => {
        const f = await fixture()
        try {
            await f.type('正在输入')
            const shown: string[] = []
            f.input.outputToTerminal$.subscribe((data: Buffer) => shown.push(data.toString()))
            f.input.feedFromSession(Buffer.from('first\r\n'))
            f.integration.commandStarted()
            f.input.feedFromSession(Buffer.from('second\r\n'))
            await f.input.settled()
            assert.equal(shown.join(''), 'first\r\nsecond\r\n')
        } finally { f.close() }
    })
    await test('right arrows edit local commands instead of leaking terminal status replies to SSH', async () => {
        for (const key of ['\x1b[C', '\x1bOC', '\x06', '\x1b[1;5C']) {
            const f = await fixture()
            try {
                await f.type('echo abcd')
                await f.type('\x01')
                await f.type(key)
                await f.type('X')
                assert.deepEqual(f.sent, [], key)
                f.input.submit('shell'); await f.input.settled()
                assert.equal(f.sent.join(''), key === '\x1b[1;5C' ? 'echo Xabcd\r' : 'eXcho abcd\r')
            } finally { f.close() }
        }
    })
    await test('device replies remain case-sensitive while uppercase RGB hex is forwarded', async () => {
        const f = await fixture()
        try {
            const replies = ['\x1b[?1;2c', '\x1b[2;5R', '\x1b]11;rgb:ABCD/EEEE/FFFF\x1b\\']
            for (const reply of replies) { await f.type(reply) }
            assert.deepEqual(f.sent, replies)
            await f.type('\x1b[C')
            assert.deepEqual(f.sent, replies, 'Right on an empty local line must not reach SSH')
        } finally { f.close() }
    })
    await test('right arrow skips complete wide glyphs and keeps their rendered cursor position', async () => {
        const f = await fixture()
        try {
            await f.type('a'.repeat(37) + '中文Z')
            await f.type('\x01')
            for (let i = 0; i < 37; i++) { await f.type('\x1b[C') }
            const screen = f.frontend.xterm.buffer.active
            assert.equal(screen.cursorY, 1)
            assert.equal(screen.cursorX, 0)
            await f.type('\x1b[C')
            assert.equal(screen.cursorX, 2)
            await f.type('新')
            f.input.submit('shell'); await f.input.settled()
            assert.equal(f.sent.join(''), 'a'.repeat(37) + '中新文Z\r')
        } finally { f.close() }
    })
    await test('right arrow places the cursor on the next character across a wrapped line', async () => {
        const f = await fixture()
        try {
            await f.type('a'.repeat(37) + 'XYZ')
            await f.type('\x01')
            for (let i = 0; i < 38; i++) { await f.type('\x1b[C') }
            const screen = f.frontend.xterm.buffer.active
            assert.equal(screen.cursorY, 1)
            assert.equal(screen.cursorX, 0)
            assert.equal(screen.getLine(screen.baseY + screen.cursorY).getCell(screen.cursorX).getChars(), 'Y')
            assert.deepEqual(f.sent, [])
        } finally { f.close() }
    })
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
