import * as assert from 'node:assert/strict'
import { AISessionCaptureMiddleware } from './session-capture.middleware'
import { SecretRedactor } from '../policy/secret-redactor'
import { AIConfig } from '../config/config-schema'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, defaults: AIConfig): Promise<void> {
    const fixture = () => {
        const events: { id: string, content: string }[] = []
        const runtime: any = { id: 'first' }
        const redactor = new SecretRedactor({ knownSecrets: new Set(['SYNTHETIC_SECRET_4831']), config: defaults } as any)
        const middleware = new AISessionCaptureMiddleware(runtime, {
            appendToContext: async (_runtime: any, id: string, _type: string, data: { content: string }) => { events.push({ id, content: data.content }) },
        } as any, redactor)
        return { events, runtime, redactor, middleware }
    }
    await test('live SSH bytes are forwarded before history processing; split secrets stay redacted', async () => {
        const f = fixture()
        const shown: Buffer[] = []
        let redactions = 0
        const redact = f.redactor.redact.bind(f.redactor)
        f.redactor.redact = text => { redactions++; return redact(text) }
        f.middleware.outputToTerminal$.subscribe(data => { assert.equal(redactions, 0); shown.push(data) })
        try {
            const first = Buffer.from('password=SYNTHETIC_')
            const second = Buffer.from('SECRET_4831\r\nplain line\r\n')
            f.middleware.feedFromSession(first)
            f.middleware.feedFromSession(second)
            assert.deepEqual(shown, [first, second])
            assert.equal(f.events.length, 0)
            await f.runtime.flushOutput()
            const history = f.events.map(event => event.content).join('')
            assert.ok(!history.includes('SYNTHETIC_SECRET_4831'))
            assert.match(history, /\[REDACTED\]/)
            assert.match(history, /plain line/)
        } finally { f.middleware.close() }
    })
    await test('deferred history retains UTF8, order and original session when switching or closing', async () => {
        const f = fixture()
        try {
            const data = Buffer.from('中文😀\r\n'.repeat(5000))
            f.middleware.feedFromSession(data.subarray(0, 1))
            f.middleware.feedFromSession(data.subarray(1))
            f.runtime.id = 'second'
            f.middleware.feedFromSession(Buffer.from('next session\r\n'))
            f.middleware.close()
            assert.equal(f.events.filter(event => event.id === 'first').map(event => event.content).join(''), data.toString())
            assert.equal(f.events.filter(event => event.id === 'second').map(event => event.content).join(''), 'next session\r\n')
        } finally { f.middleware.close() }
    })
    await test('sustained output is captured in bounded history slices', async () => {
        const f = fixture()
        const input = 'output\r\n'.repeat(15000)
        try {
            f.middleware.feedFromSession(Buffer.from(input))
            await new Promise(resolve => setTimeout(resolve, 50))
            await f.runtime.flushOutput()
            assert.equal(f.events.map(event => event.content).join(''), input)
        } finally { f.middleware.close() }
    })
    await test('command boundaries drain asynchronously and preserve event ordering', async () => {
        const f = fixture()
        try {
            const output = 'large output\r\n'.repeat(10000)
            f.middleware.feedFromSession(Buffer.from(output))
            const flushed = f.runtime.flushOutput().then(() => { f.events.push({ id: 'first', content: 'COMMAND_END' }) })
            assert.equal(f.events.length, 0, 'End-of-command capture must not block the receive callback')
            f.middleware.feedFromSession(Buffer.from('next prompt\r\n'))
            await flushed
            await f.runtime.flushOutput()
            assert.equal(f.events.map(event => event.content).join(''), output + 'COMMAND_ENDnext prompt\r\n')
        } finally { f.middleware.close() }
    })
}
