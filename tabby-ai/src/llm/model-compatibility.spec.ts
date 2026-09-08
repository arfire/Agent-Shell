import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import { ChatCompletionsClient } from './chat-completions.client'
import { ModelCompatibilityService, ModelCheck } from './model-compatibility.service'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    let mode = 'good'
    const requests: any[] = []
    const server = http.createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) { body += chunk }
        const request = JSON.parse(body)
        requests.push(request)
        if (mode === 'auth') { res.writeHead(401); res.end('invalid secret-key'); return }
        if (mode === 'parameter') { res.writeHead(400); res.end('temperature unsupported secret-key'); return }
        if (mode === 'timeout') { return }
        if (!request.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
            return
        }
        if (mode === 'non-stream') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
            return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = (value: unknown): string => 'data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\r\n\r\n'
        if (mode === 'bad-json') { res.end('data: {not JSON}\n\n'); return }
        if (mode === 'broken') { res.end(delta({ content: 'unfinished' })); return }
        let result = ''
        if (request.tools?.length && mode !== 'chat-only') {
            const last = request.messages.at(-1)
            if (last.role === 'tool') {
                assert.equal(last.tool_call_id, 'check-id')
                result = delta({ content: mode === 'bad-result' ? 'ignored' : JSON.parse(last.content).value })
            } else {
                result = delta({ tool_calls: [{ index: 0, id: 'check-id', type: 'function', 'function': { name: 'ash_connection_check', arguments: '{"text":' } }] }) +
                    delta({ tool_calls: [{ index: 0, 'function': { arguments: mode === 'bad-args' ? 'bad}' : '"ash-check"}' } }] })
            }
        } else { result = delta({ content: '中文 OK' }) }
        result += 'data: [DONE]'
        // Split UTF-8 and SSE frames, deliberately omit the final newline.
        const bytes = Buffer.from(result)
        for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)) }
        res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const settings = { baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: 'test', apiKey: 'secret-key', temperature: 0.2, timeout: 1000 }
    const client = new ChatCompletionsClient({ config: { llm: settings } } as any)
    const compatibility = new ModelCompatibilityService(client)
    const check = (): Promise<ModelCheck[]> => compatibility.check(settings, () => undefined, new AbortController().signal)
    try {
        await test('four capability checks use real HTTP streaming and simulated tool result round trip', async () => {
            const updates: ModelCheck[][] = []
            const result = await compatibility.check(settings, rows => updates.push(rows), new AbortController().signal)
            assert.ok(result.every(row => row.state === 'passed'))
            assert.equal(requests.length, 4)
            assert.ok(updates.some(rows => rows[2].state === 'running'))
            assert.equal(requests[2].tool_choice, 'auto')
            assert.equal(requests[2].tools[0].function.name, 'ash_connection_check')
            assert.ok(requests.every(request => request.temperature === 0.2))
        })
        await test('chat-only service passes text checks but fails tools and skips result check', async () => {
            mode = 'chat-only'
            assert.deepEqual((await check()).map(row => row.state), ['passed', 'passed', 'failed', 'skipped'])
        })
        await test('invalid tool arguments and ignored tool results cannot pass compatibility check', async () => {
            mode = 'bad-args'
            assert.equal((await check())[2].state, 'failed')
            mode = 'bad-result'
            assert.deepEqual((await check()).map(row => row.state), ['passed', 'passed', 'passed', 'failed'])
        })
        await test('HTTP authentication and parameter failures explain the cause without echoing the API key', async () => {
            mode = 'auth'
            const before = requests.length
            const result = await check()
            assert.match(result[0].message, /认证失败/)
            assert.equal(requests.length, before + 1)
            assert.ok(result.slice(1).every(row => row.state === 'skipped'))
            mode = 'parameter'
            assert.equal(JSON.stringify(await check()).includes(settings.apiKey), false)
        })
        await test('non-SSE replies, broken streams and malformed JSON report failure', async () => {
            for (const value of ['non-stream', 'broken', 'bad-json']) {
                mode = value
                const result = await check()
                assert.equal(result[0].state, 'passed')
                assert.equal(result[1].state, 'failed')
            }
        })
        await test('cancellation stops the in-flight request and skips remaining requests', async () => {
            mode = 'timeout'
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 100)
            const before = requests.length
            const result = await compatibility.check(settings, () => undefined, controller.signal)
            clearTimeout(timer)
            assert.ok(result.every(row => row.state === 'cancelled'))
            assert.equal(requests.length, before + 1)
        })
        await test('request timeout is reported without leaving the check running', async () => {
            mode = 'timeout'
            const result = await compatibility.check({ ...settings, timeout: 50 }, () => undefined, new AbortController().signal)
            assert.match(result[0].message, /超时/)
            assert.equal(result[3].state, 'skipped')
        })
    } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
}
