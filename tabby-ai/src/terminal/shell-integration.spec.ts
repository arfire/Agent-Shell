import * as assert from 'node:assert/strict'
import { ShellIntegration } from './shell-integration'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    await test('failed integration cannot be reopened by an outstanding render callback', async () => {
        let finish = (): void => { throw new Error('Render drain was not started') }
        const integration = new ShellIntegration(() => new Promise<void>(resolve => { finish = resolve }))
        const marker = (value: string): string => `\x1b]777;ash;${integration.nonce};${value}\x07`
        try {
            integration.feedFromSession(Buffer.from(marker('READY;bash') + marker('A') + '$ ' + marker('B')))
            integration.fail('test failure')
            finish()
            await Promise.resolve()
            assert.equal(integration.ready, false)
            assert.equal(integration.state.value, 'unavailable')
        } finally { integration.close() }
    })
    await test('SSH prompt readiness follows rendered bytes without a quiet-period timer', async () => {
        const drains: (() => void)[] = []
        const integration = new ShellIntegration(() => new Promise<void>(resolve => drains.push(resolve)))
        const marker = (value: string): string => `\x1b]777;ash;${integration.nonce};${value}\x07`
        try {
            integration.feedFromSession(Buffer.from(marker('READY;bash') + marker('A') + '$ ' + marker('B')))
            assert.equal(drains.length, 1, 'SSH output must drain immediately, not wait 40 ms')
            assert.equal(integration.ready, false)
            // Additional output must not keep extending the prompt wait.
            integration.feedFromSession(Buffer.from('\x1b[?2004h'))
            assert.equal(drains.length, 1)
            drains.shift()!()
            await Promise.resolve()
            assert.equal(integration.ready, true)
        } finally { integration.close() }
    })
    await test('a stale render callback cannot mark a newer incomplete prompt ready', async () => {
        const drains: (() => void)[] = []
        const integration = new ShellIntegration(() => new Promise<void>(resolve => drains.push(resolve)))
        const marker = (value: string): string => `\x1b]777;ash;${integration.nonce};${value}\x07`
        try {
            integration.feedFromSession(Buffer.from(marker('READY;bash') + marker('A') + '$ ' + marker('B')))
            integration.feedFromSession(Buffer.from(marker('A') + 'new'))
            drains.shift()!()
            await Promise.resolve()
            assert.equal(integration.ready, false)
            integration.feedFromSession(Buffer.from('$ ' + marker('B')))
            drains.shift()!()
            await Promise.resolve()
            assert.equal(integration.ready, true)
        } finally { integration.close() }
    })
}
