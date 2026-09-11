import * as assert from 'node:assert/strict'
import { Subject } from 'rxjs'
import { executeSSH, ExecChannel } from './ssh-exec'
import { TerminalHistoryFilter } from './terminal-history-filter'
import { normalizePaste } from '../../../tabby-terminal/src/paste-text'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    const fixture = () => {
        const data$ = new Subject<Uint8Array>(), extendedData$ = new Subject<[number, Uint8Array]>()
        const eof$ = new Subject<void>(), closed$ = new Subject<void>()
        let command = '', eof = false, closed = 0
        const channel: ExecChannel = {
            data$, extendedData$, eof$, closed$,
            requestExec: async value => { command = value },
            eof: async () => { eof = true }, close: async () => { closed++ },
        }
        const marker = () => /__ASH_EXEC_[a-f0-9]+__/.exec(command)![0]
        return { channel, data$, extendedData$, eof$, closed$, marker, get command () { return command }, get eof () { return eof }, get closed () { return closed } }
    }
    const tick = () => new Promise<void>(resolve => setImmediate(resolve))
    await test('SSH exec has no PTY, closes stdin, preserves split UTF-8 and drains late stderr', async () => {
        const f = fixture(), visible: string[] = []
        const result = executeSSH(async () => f.channel, 'systemctl status demo', 'bash', text => visible.push(text))
        await tick()
        assert.match(f.command, /SYSTEMD_PAGER=cat/)
        assert.equal(f.eof, true)
        const bytes = Buffer.from('服务运行中\n')
        for (const byte of bytes) { f.data$.next(Buffer.from([byte])) }
        assert.equal(visible.join(''), '服务运行中\n', 'short output must not wait for a marker tail')
        f.closed$.next()
        for (const byte of Buffer.from(f.marker() + ':3\x07')) { f.data$.next(Buffer.from([byte])) }
        f.extendedData$.next([1, Buffer.from('warning\n')])
        assert.deepEqual(await result, { output: '服务运行中\nwarning\n', exitCode: 3 })
        assert.equal(f.closed, 1)
    })
    await test('missing exit status never reports success', async () => {
        const f = fixture()
        const result = executeSSH(async () => f.channel, 'exit', 'bash', () => undefined)
        await tick()
        f.data$.next(Buffer.from('partial result'))
        f.eof$.next()
        await assert.rejects(result, /未收到退出状态/)
    })
    await test('SSH timeout and stop release the channel even while opening is stalled', async () => {
        const f = fixture()
        await assert.rejects(executeSSH(async () => f.channel, 'sleep 999', 'bash', () => undefined, undefined, 20), /超时/)
        assert.equal(f.closed, 1)
        const controller = new AbortController()
        let opened: (channel: ExecChannel) => void = () => undefined
        const result = executeSSH(() => new Promise(resolve => { opened = resolve }), 'sleep 999', 'bash', () => undefined, controller.signal)
        controller.abort(new Error('test stop'))
        await assert.rejects(result, /test stop/)
        opened(f.channel)
        await tick()
        assert.equal(f.closed, 2)
    })
    await test('history handles chunked Vim screens, prompt editing, OSC clipboard data and progress redraws', async () => {
        const filter = new TerminalHistoryFilter()
        const source = '$ caX\bt file\r\n\x1b[?1049h\x1b[2Jvim private content\x1b[?1049l$ done\r\n10%\r100%\x1b[K\r\n\x1b]52;c;clipboard-secret\x07'
        let output = ''
        for (const character of source) { output += filter.feed(character) }
        output += filter.flush()
        assert.match(output, /\$ cat file/)
        assert.match(output, /\$ done/)
        assert.match(output, /100%/)
        assert.equal(output.includes('vim private'), false)
        assert.equal(output.includes('clipboard-secret'), false)
        assert.equal(output.includes('\x1b'), false)
    })
    await test('Vim paste preserves multiline indentation for LF, CRLF and CR clipboards', async () => {
        for (const newline of ['\n', '\r\n', '\r']) {
            const input = ['first', '    中文 second', ''].join(newline)
            assert.equal(normalizePaste(input, true, true), 'first\r    中文 second\r')
            assert.equal(normalizePaste(input, false, false), 'first\r    中文 second\r')
            assert.equal(normalizePaste(input, false, true), 'first     中文 second ')
        }
    })
}
