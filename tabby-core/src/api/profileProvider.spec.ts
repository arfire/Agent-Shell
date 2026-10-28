import * as assert from 'node:assert/strict'
import { profileForStorage } from './profileProvider'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    await test('recent and recovery profiles omit SSH passwords while live reconnect credentials remain intact', async () => {
        const live = { type: 'ssh', name: 'test', id: 'one', options: Object.freeze({ host: 'example.invalid', port: 22, password: 'synthetic-only' }) }
        const stored = profileForStorage(live)
        assert.equal(JSON.stringify(stored).includes('synthetic-only'), false)
        assert.deepEqual(stored, { type: 'ssh', name: 'test', id: 'one', options: { host: 'example.invalid', port: 22 } })
        assert.equal(live.options.password, 'synthetic-only')
        const local = { type: 'local', name: 'shell', options: { command: 'bash', env: { PUBLIC_SETTING: 'kept' } } }
        assert.equal(profileForStorage(local), local)
    })
}
