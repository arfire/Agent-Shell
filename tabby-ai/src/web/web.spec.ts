import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import { gzipSync } from 'node:zlib'
import { BehaviorSubject } from 'rxjs'
import { defaultWebConfig, validateWebConfig } from '../config/config-schema'
import { ChatCompletionsClient } from '../llm/chat-completions.client'
import { WebService, webAllowed, WebActivity, WebRunState } from './web.service'
import { extractWebContent } from './web-content'
import { isPublicAddress, requestWeb, webURL } from './web-http'
import { AgentService } from '../agent/agent.service'
import { SecretRedactor } from '../policy/secret-redactor'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, load: (name: string) => any): Promise<void> {
    const requests: { url: string, authorization?: string }[] = []
    const modelRequests: any[] = []
    let mode = 'good'
    let modelMode = 'good'
    const server = http.createServer(async (req, res) => {
        requests.push({ url: req.url ?? '', authorization: req.headers.authorization })
        if (new URL(req.url ?? '/', 'http://localhost').searchParams.get('language') === 'auto') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid value "auto" for parameter language' }))
            return
        }
        if (req.url?.startsWith('/v1/')) {
            let body = ''
            for await (const chunk of req) { body += chunk }
            const message = JSON.parse(body)
            modelRequests.push(message)
            if (modelMode === 'auth') { res.writeHead(401); res.end('custom-secret'); return }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            const delta = message.messages.at(-1).role === 'tool'
                ? { content: '资料结论：版本需要核对。https://docs.example.com/guide' }
                : { tool_calls: [{ index: 0, id: 'read', type: 'function', 'function': { name: modelMode === 'terminal' ? 'terminal_exec' : 'web_fetch', arguments: JSON.stringify({ url: 'https://docs.example.com/guide' }) } }] }
            res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n')
            return
        }
        if (mode === 'slow') { return }
        if (mode === '403') { res.writeHead(403); res.end('denied'); return }
        if (mode === 'html') { res.setHeader('Content-Type', 'text/html'); res.end('<html>login</html>'); return }
        if (mode === 'redirect') { res.writeHead(302, { Location: '/private' }); res.end(); return }
        if (mode === 'large') { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync('x'.repeat(3 * 1024 * 1024))); return }
        if (mode === 'gzip') { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync('中文正文')); return }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ results: [
            { title: '<b>Official</b>', url: 'https://docs.example.com/guide', content: 'Version &amp; usage' },
            { title: 'duplicate', url: 'https://docs.example.com/guide#other', content: 'duplicate' },
            { title: 'Other', url: 'https://other.example.com/', content: 'Other source' },
            { title: 'Bad', url: 'file:///secret', content: 'bad' },
        ], unresponsive_engines: [['engine', 'timeout']] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseURL = `http://127.0.0.1:${(server.address() as any).port}`
    const web = { ...defaultWebConfig(), mode: 'auto' as const, baseURL, authorization: 'Bearer search-secret' }
    const config: any = { config: { web, llm: { ...web.model, model: 'main-model' }, redaction: { enabled: false, patterns: [] }, agent: { maxContextTokens: 32000 } } }
    const client = new ChatCompletionsClient(config)
    const service = new WebService(config, client)
    const events: WebActivity[] = []
    const protect = (value: string): string => value.replace(/search-secret|custom-secret/g, '[REDACTED]')
    const state = (): WebRunState => ({ input: '联网搜索官方文档', calls: 0, remainingChars: 32000 })
    const call = (name: string, args: unknown, run = state(), signal = new AbortController().signal): Promise<any> =>
        service.execute({ id: 'test', type: 'function', 'function': { name, arguments: JSON.stringify(args) } }, run, signal, protect, async event => { events.push(event) }).then(value => JSON.parse(value))
    const transport = load('tabby-ai/src/web/web-http.ts')
    const originalTransport = transport.requestWeb
    try {
        await test('web defaults, model validation, and manual/disabled registration', async () => {
            validateWebConfig(defaultWebConfig())
            assert.equal(defaultWebConfig().useDefaultModel, true)
            assert.throws(() => validateWebConfig({ ...web, useDefaultModel: false }), /URL|模型/)
            assert.throws(() => validateWebConfig({ ...web, authorization: 'Bearer x\r\ny: z' }))
            assert.throws(() => validateWebConfig({ ...web, baseURL: baseURL + '?token=x' }))
            assert.equal(webAllowed({ ...web, mode: 'manual' }, '分析这个问题'), false)
            assert.equal(webAllowed({ ...web, mode: 'manual' }, '查文档'), true)
            assert.equal(webAllowed(web, '不要联网，解释已有结果'), false)
            config.config.web = { ...web, mode: 'off' }
            assert.deepEqual(service.tools('联网搜索'), [])
            const before = requests.length
            assert.match((await call('web_search', { query: 'test' })).error, /未启用/)
            assert.equal(requests.length, before)
            config.config.web = web
        })
        await test('private search JSON, authentication, deduplication and domain filtering', async () => {
            assert.match(await service.testConnection(web, new AbortController().signal), /JSON 搜索接口可用/)
            const result = await call('web_search', { query: 'version', domains: ['docs.example.com'], time_range: 'month' })
            assert.equal(result.results.length, 1)
            assert.equal(result.results[0].title, 'Official')
            assert.equal(result.results[0].content, 'Version & usage')
            assert.match(result.warning, /1 个/)
            assert.equal(requests.at(-1)?.authorization, 'Bearer search-secret')
            const query = new URL(requests.at(-1)!.url, baseURL)
            assert.equal(query.searchParams.get('format'), 'json')
            assert.equal(query.searchParams.get('time_range'), 'month')
            assert.equal(query.searchParams.has('language'), false)
            assert.equal(modelRequests.length, 0, 'default model reads tool output directly')
        })
        await test('automatic and empty language use server defaults, explicit language is preserved', async () => {
            for (const language of ['auto', ' AUTO ', '', '  ', 'en', ' zh-CN ']) {
                await service.testConnection({ ...web, language }, new AbortController().signal)
                const query = new URL(requests.at(-1)!.url, baseURL)
                assert.equal(query.searchParams.get('language'), !language.trim() || language.trim().toLowerCase() === 'auto' ? null : language.trim())
            }
        })
        await test('sensitive and malformed arguments never reach the search endpoint', async () => {
            const before = requests.length
            assert.match((await call('web_search', { query: 'search-secret' })).error, /敏感/)
            assert.match((await call('web_search', { query: '__TABBY_SENSITIVE_1__' })).error, /敏感/)
            assert.ok((await call('web_search', null)).error)
            assert.ok((await call('web_search', { query: 'x', domains: ['x/path'] })).error)
            assert.equal(requests.length, before)
        })
        await test('HTML extraction retains code and tables while removing scripts, navigation and controls', async () => {
            const result = extractWebContent('<title>Guide</title><nav>NO NAV</nav><main><h1>Install</h1><pre>  line1\n    line2</pre><table><tr><td>Version</td><td>2</td></tr></table><script>NO SCRIPT</script><p hidden>HIDDEN</p><p>A &lt; B\x1b[31m</p></main>', 1000)
            assert.equal(result.title, 'Guide')
            assert.match(result.content, /Install/)
            assert.match(result.content, /  line1/)
            assert.match(result.content, /    line2/)
            assert.match(result.content, /Version/)
            assert.match(result.content, /A < B/)
            assert.doesNotMatch(result.content, /NO NAV|NO SCRIPT|HIDDEN|\x1b/)
            assert.equal(extractWebContent('<p>' + 'x'.repeat(200) + '</p>', 50).truncated, true)
        })
        await test('public-page policy rejects alternate loopback, IPv6 transition and DNS-private addresses', async () => {
            for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1']) {
                assert.equal(isPublicAddress(address), false, address)
            }
            assert.equal(isPublicAddress('8.8.8.8'), true)
            assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
            const before = requests.length
            for (const url of [baseURL, baseURL.replace('127.0.0.1', 'localhost'), 'http://2130706433/', 'http://[::ffff:127.0.0.1]/']) {
                await assert.rejects(requestWeb(url, 1000, new AbortController().signal), /内网|保留/)
            }
            assert.equal(requests.length, before)
            assert.throws(() => webURL('http://user:password@example.com'))
            assert.throws(() => webURL('file:///secret'))
        })
        await test('search failures identify JSON, HTTP, redirect and response size problems', async () => {
            for (const [next, expected] of [['403', /403/], ['html', /JSON/], ['redirect', /重定向/], ['large', /2 MB/]] as const) {
                mode = next
                await assert.rejects(service.testConnection(web, new AbortController().signal), expected)
            }
            mode = 'gzip'
            assert.equal((await requestWeb(baseURL, 1000, new AbortController().signal, true)).text, '中文正文')
            mode = 'good'
        })
        await test('timeouts and user cancellation stop pending local requests', async () => {
            mode = 'slow'
            await assert.rejects(requestWeb(baseURL, 40, new AbortController().signal, true), /超时/)
            const controller = new AbortController()
            const promise = call('web_search', { query: 'test' }, state(), controller.signal)
            setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 30)
            await assert.rejects(promise, /Stopped/)
            mode = 'good'
        })
        await test('call and content budgets prevent unbounded research', async () => {
            const run = { ...state(), calls: web.maxCallsPerRun }
            const before = requests.length
            assert.match((await call('web_search', { query: 'test' }, run)).error, /预算/)
            assert.match((await call('web_search', { query: 'test' }, { ...state(), remainingChars: 100 })).error, /预算/)
            assert.equal(requests.length, before)
        })
        await test('main Agent searches, reads a page, and receives valid redacted JSON without executing SSH', async () => {
            transport.requestWeb = async (...args: any[]) => args[0].startsWith('https://docs.example.com')
                ? { url: args[0], status: 200, headers: { 'content-type': 'text/plain' }, text: 'Example: password="example-password"\nVersion 2 requires reload.' }
                : originalTransport(...args)
            const redactor = new SecretRedactor(config)
            let modelStep = 0
            const timeline: any[] = []
            const mainClient = { stream: async (messages: any[], tools: any[]) => {
                assert.ok(tools.some(tool => tool.function.name === 'web_search'))
                assert.ok(tools.some(tool => tool.function.name === 'terminal_exec'))
                modelStep++
                if (modelStep === 1) {
                    return { content: '', toolCalls: [{ id: 'search', type: 'function', 'function': { name: 'web_search', arguments: '{"query":"version 2 documentation"}' } }] }
                }
                const last = messages.at(-1)
                assert.equal(last.role, 'tool')
                const result = JSON.parse(last.content)
                if (modelStep === 2) {
                    assert.equal(result.results[0].url, 'https://docs.example.com/guide')
                    return { content: '', toolCalls: [{ id: 'fetch', type: 'function', 'function': { name: 'web_fetch', arguments: '{"url":"https://docs.example.com/guide"}' } }] }
                }
                assert.match(result.page.content, /Version 2 requires reload/)
                assert.doesNotMatch(result.page.content, /example-password/)
                return { content: '根据文档，版本 2 需要 reload：https://docs.example.com/guide', toolCalls: [] }
            } }
            const agent: any = new AgentService(config, mainClient as any, { build: () => [] } as any, null as any, redactor,
                { append: async (_runtime: unknown, type: string, data: unknown) => { timeline.push({ type, data }) } } as any,
                null as any, null as any, { execute: () => { throw new Error('SSH must not execute') } } as any, null as any, { mode: () => 'configured' } as any, service)
            const runtime: any = { state: new BehaviorSubject('THINKING'), liveText: new BehaviorSubject(''), tab: { session: {} } }
            const run: any = { id: 'web-loop', controller: new AbortController(), stopRequested: false, sensitive: redactor.createScope(), session: runtime.tab.session }
            await agent.runLoop(runtime, run, '联网查文档')
            assert.equal(modelStep, 3)
            assert.equal(run.web.calls, 2)
            assert.ok(timeline.some(event => event.type === 'web-activity' && event.data.result?.page))
            assert.ok(timeline.some(event => event.type === 'ai-message' && /根据文档/.test(event.data.content)))
            assert.doesNotMatch(JSON.stringify(timeline), /example-password/)
            transport.requestWeb = originalTransport
        })
        await test('custom model uses its own endpoint and key, reads pages, and cannot execute terminal tools', async () => {
            config.config.web = { ...web, useDefaultModel: false, model: { ...web.model, baseURL: baseURL + '/v1', apiKey: 'custom-secret', model: 'research-model' } }
            // Isolate public webpage content while retaining real local search and model HTTP.
            transport.requestWeb = async (...args: any[]) => args[0].startsWith('https://docs.example.com')
                ? { url: args[0], status: 200, headers: { 'content-type': 'text/html' }, text: '<main>Verified version 2 documentation</main>' }
                : originalTransport(...args)
            const result = await call('web_search', { query: 'version' })
            assert.match(result.summary, /版本需要核对/)
            assert.match(result.sources[0].content, /Verified version 2/)
            assert.ok(modelRequests.every(request => request.model === 'research-model'))
            assert.ok(modelRequests.every(request => request.tools?.every((tool: any) => ['web_search', 'web_fetch'].includes(tool.function.name))))
            assert.ok(requests.filter(request => request.url.startsWith('/v1/')).every(request => request.authorization === 'Bearer custom-secret'))
            modelMode = 'terminal'
            const before = requests.length
            await call('web_search', { query: 'version' })
            assert.ok(modelRequests.at(-1).messages.some((message: any) => message.role === 'tool' && /只能搜索/.test(message.content)))
            assert.equal(requests.length - before, 3, 'only search and two model requests, never terminal execution')
            modelMode = 'auth'
            const failure = await call('web_search', { query: 'version' })
            assert.match(failure.error, /401/)
            assert.doesNotMatch(JSON.stringify(events), /custom-secret|search-secret/)
            assert.ok(modelRequests.every(request => request.model !== 'main-model'), 'never silently falls back')
        })
    } finally {
        transport.requestWeb = originalTransport
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
}
