/* Run with Node 22: node scripts/test-native-agent.cjs */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('../node_modules/typescript')
const { BehaviorSubject } = require('../node_modules/rxjs')
const yaml = require('../tabby-ai/node_modules/js-yaml')
global.self = global
const { Terminal } = require('../tabby-terminal/node_modules/@xterm/xterm')
const root = path.resolve(__dirname, '..')
const cache = new Map()
class XTermFrontend {
    constructor () { this.xterm = new Terminal({ allowProposedApi: true, cols: 40, rows: 12, scrollback: 1000 }) }
    supportsBracketedPaste () { return true }
    focus () {}
}
class SubscriptionContainer {
    subscriptions = []
    subscribe (observable, callback) { this.subscriptions.push(observable.subscribe(callback)) }
    cancelAll () { this.subscriptions.forEach(s => s.unsubscribe()); this.subscriptions = [] }
}
function load (file) {
    const filename = path.resolve(root, file)
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
    const localRequire = id => {
        if (id === '@angular/core') return { Injectable: () => value => value, Component: () => value => value, Input: () => () => undefined, ViewChild: () => () => undefined }
        if (id === 'tabby-core') return { SubscriptionContainer }
        if (id === 'tabby-terminal') return { ...load('tabby-terminal/src/api/middleware.ts'), XTermFrontend }
        // Simulate a Windows checkout even when the tests run on Unix.
        if (id.startsWith('!!raw-loader!')) return { default: fs.readFileSync(path.resolve(path.dirname(filename), id.slice(13)), 'utf8').replace(/\r?\n/g, '\r\n') }
        if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id + '.ts'))
        return require(id)
    }
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(localRequire, module, module.exports)
    return module.exports
}
const { AIInputDetector, unwrapShellFence } = load('tabby-ai/src/terminal/input-detector.ts')
const { AIInputMiddleware } = load('tabby-ai/src/terminal/ai-input.middleware.ts')
const { ShellIntegration, detectShellKind, shellBootstrap } = load('tabby-ai/src/terminal/shell-integration.ts')
const { TerminalTextFilter } = load('tabby-ai/src/terminal/terminal-text.ts')
const { historyChunks } = load('tabby-ai/src/terminal/session-history.ts')
const { TerminalMarkdown, terminalMarkdown } = load('tabby-ai/src/terminal/terminal-markdown.ts')
const { CommandFramingMiddleware } = load('tabby-ai/src/terminal/command-framing.middleware.ts')
const { SecretRedactor } = load('tabby-ai/src/policy/secret-redactor.ts')
const defaults = yaml.load(fs.readFileSync(path.join(root, 'tabby-ai/default-config.yaml'), 'utf8'))
const detector = new AIInputDetector({ config: defaults })
const tick = () => new Promise(resolve => setImmediate(resolve))
let count = 0
async function test (name, action) { await action(); console.log('PASS', name); count++ }

async function fixture () {
    const frontend = new XTermFrontend()
    const sent = [], agent = [], events = []
    let writing = Promise.resolve()
    const runtime = {
        id: 'test', locked: false, events: new BehaviorSubject([]), liveText: new BehaviorSubject(''), state: new BehaviorSubject('IDLE'),
        terminal: new BehaviorSubject({ mode: 'agent', ready: true, state: 'prompt', notice: '' }),
        tab: { frontend, write: text => writing = writing.then(() => new Promise(resolve => frontend.xterm.write(text, resolve))) },
    }
    const integration = new ShellIntegration(() => runtime.tab.write(''))
    const input = new AIInputMiddleware(runtime, { append: async (...args) => events.push(args) }, detector, integration, text => agent.push(text), () => {})
    integration.outputToTerminal$.subscribe(data => input.feedFromSession(data))
    input.outputToTerminal$.subscribe(data => runtime.tab.write(data.toString()))
    input.outputToSession$.subscribe(data => sent.push(data.toString()))
    const marker = text => '\x1b]777;ash;' + integration.nonce + ';' + text + '\x07'
    const prompt = async () => {
        integration.feedFromSession(Buffer.from(marker('READY;bash') + marker('A') + '$ ' + marker('B')))
        await new Promise(resolve => setTimeout(resolve, 60)); await runtime.tab.write(''); await tick()
    }
    await prompt()
    const type = async text => { input.feedFromTerminal(Buffer.from(text)); await input.settled(); await runtime.tab.write('') }
    const close = () => { integration.close(); input.close(); frontend.xterm.dispose() }
    return { frontend, runtime, integration, input, sent, agent, events, marker, prompt, type, close }
}

async function main () {
    await load('tabby-ai/src/terminal/ssh-exec.spec.ts').runTests(test)
    await test('shell bootstrap normalizes Windows script line endings before encoding', () => {
        for (const kind of ['bash', 'zsh', 'fish', 'powershell']) {
            const command = shellBootstrap(kind, 'newline-test')
            const encoded = command.match(/'([A-Za-z0-9+/=]{40,})'/)?.[1]
            assert.ok(encoded, kind)
            const script = Buffer.from(encoded, 'base64').toString('utf8')
            assert.ok(script.includes('\n'), kind)
            assert.ok(!script.includes('\r'), kind)
            assert.ok(script.includes('newline-test'), kind)
            assert.ok(!script.includes('__NONCE__'), kind)
            assert.ok(command.endsWith('\r'), 'terminal Enter must be preserved')
        }
    })
    await load('tabby-ai/src/ui/agent-dock.component.spec.ts').runTests(test)
    await test('Fish startup screen probes and ST-terminated prompt markers preserve bootstrap detection', () => {
        const integration = new ShellIntegration(async () => {})
        const sent = []
        integration.outputToSession$.subscribe(value => sent.push(value.toString()))
        try {
            integration.setShell('fish')
            integration.setAlternateScreen(true)
            integration.feedFromSession(Buffer.from('\x1b]133;A\x1b\\user@host ~> \x1b]133;B\x07'))
            assert.equal(sent.length, 0)
            integration.setAlternateScreen(false)
            assert.equal(sent.length, 1)
            assert.equal(integration.state.value, 'initializing')
        } finally { integration.close() }
    })
    await test('failed bootstrap exposes its cause without dumping encoded commands, and retry waits for a prompt', () => {
        const integration = new ShellIntegration(async () => {})
        const sent = [], shown = []
        integration.outputToSession$.subscribe(value => sent.push(value.toString()))
        integration.outputToTerminal$.subscribe(value => shown.push(value.toString()))
        try {
            integration.setShell('bash')
            integration.feedFromSession(Buffer.from('test@host:~$ '))
            assert.equal(sent.length, 1)
            integration.feedFromSession(Buffer.from('eval ENCODED_BOOTSTRAP\r\n-bash: syntax error near unexpected token\r\n'))
            integration.feedFromSession(Buffer.from('\x1b['))
            integration.feedFromSession(Buffer.from('6n\x1b]11;?\x1b\\'))
            assert.ok(shown.includes('\x1b[6n'))
            assert.ok(shown.includes('\x1b]11;?\x1b\\'))
            assert.ok(!shown.join('').includes('ENCODED_BOOTSTRAP'))
            integration.fail('未能确认提示符，已切回 Shell 模式')
            assert.match(integration.failureReason.value, /syntax error/)
            assert.ok(!shown.join('').includes('ENCODED_BOOTSTRAP'))
            assert.equal(integration.mode.value, 'shell')
            integration.enable()
            assert.equal(integration.failureReason.value, '')
            assert.equal(sent.length, 1, 'Retry must not submit a partially edited remote line')
            integration.feedFromSession(Buffer.from('test@host:~$ '))
            assert.equal(sent.length, 2)
        } finally { integration.close() }
    })
    await load('tabby-ai/src/session/ai-session.service.spec.ts').runTests(test)
    await load('tabby-ai/src/policy/credential-guard.spec.ts').runTests(test, defaults)
    await load('tabby-ai/src/policy/execution-boundary.spec.ts').runTests(test, defaults)
    await load('tabby-ai/src/terminal/ai-input.middleware.spec.ts').runTests(test, fixture)
    await test('terminal color and capability replies do not end Fish bootstrap while its startup screen probe is active', async () => {
        const f = await fixture()
        try {
            f.integration.state.next('initializing')
            f.integration.setAlternateScreen(true)
            for (const reply of ['\x1b]11;rgb:1616/1616/1616\x1b\\', '\x1bP1+r696e646e=1b5b53\x1b\\']) {
                f.input.feedFromTerminal(Buffer.from(reply))
                assert.equal(f.integration.state.value, 'initializing')
                assert.equal(f.sent.at(-1), reply)
            }
            assert.deepEqual(f.agent, [])
        } finally { f.close() }
    })
    const { approvalAction, AgentPermissionsService } = load('tabby-ai/src/policy/agent-permissions.service.ts')
    const { CommandPolicyService } = load('tabby-ai/src/policy/command-policy.service.ts')
    const { AgentService } = load('tabby-ai/src/agent/agent.service.ts')
    await test('permission tiers execute, request approval and deny consistently through Agent tools', async () => {
        for (const [mode, expected] of Object.entries({ configured: ['execute', 'ask', 'ask', 'deny'], auto: ['execute', 'execute', 'ask', 'deny'], full: ['execute', 'execute', 'execute', 'deny'], unrestricted: ['execute', 'execute', 'execute', 'execute'] })) {
            for (const [index, risk] of ['SAFE', 'MODIFY', 'DANGEROUS', 'DENY'].entries()) {
                const config = { config: { ...defaults, policy: { ...defaults.policy, approvalMode: mode, autoApprove: [], requireApproval: [], requireSecondApproval: [], deny: [], commandRules: [{ command: 'pwd', risk }] } } }
                const events = [], approvals = [], executions = []
                const runtime = { id: 'permissions', tab: {}, state: new BehaviorSubject('THINKING'), events: new BehaviorSubject([]) }
                const run = { id: 'run', controller: new AbortController(), stopRequested: false, sensitive: new SecretRedactor(config).createScope() }
                const agent = new AgentService(config, null, null, new CommandPolicyService(config), null,
                    { append: async (_runtime, type, data) => events.push({ type, data }) },
                    { request: async request => { approvals.push(request); return { approved: true, command: request.command } } },
                    null, { execute: async (_runtime, command) => { executions.push(command); return { output: 'test', exitCode: 0 } } },
                    { interrupt: async () => {}, open: async () => {} }, new AgentPermissionsService(config, null))
                assert.equal(approvalAction(risk, mode), expected[index])
                await agent.executeTool(runtime, run, { function: { name: 'terminal_exec', arguments: JSON.stringify({ command: 'pwd', reason: 'Test' }) } })
                assert.equal(executions.length, expected[index] === 'deny' ? 0 : 1, mode + ':' + risk)
                assert.equal(approvals.length, expected[index] === 'ask' ? 1 : 0)
                if (approvals.length) assert.equal(approvals[0].confirmationsRequired, risk === 'DANGEROUS' ? 2 : 1)
                if (expected[index] === 'execute') assert.ok(events.some(e => e.type === 'approval' && e.data.automatic && e.data.permissionMode === mode))
                const before = executions.length
                await agent.executeTool(runtime, run, { function: { name: 'terminal_exec', arguments: JSON.stringify({ command: '  ', reason: 'Test' }) } })
                assert.equal(executions.length, before)
            }
        }
    })
    await test('permission snapshot stays stable and literal rules respect boundaries and dangerous syntax', () => {
        const config = { config: { ...defaults, policy: { ...defaults.policy, approvalMode: 'configured', commandRules: [{ command: 'git status', risk: 'SAFE' }, { command: 'git push', risk: 'DENY' }] } } }
        const permissions = new AgentPermissionsService(config, null)
        const runtime = { approvalMode: 'auto' }
        const snapshot = permissions.snapshot(runtime)
        runtime.approvalMode = 'full'
        config.config.policy.commandRules[0].risk = 'DENY'
        const policy = new CommandPolicyService(config)
        assert.equal(snapshot.mode, 'auto')
        assert.equal(policy.evaluate('git status --short', 'bash', snapshot.policy).risk, 'SAFE')
        assert.equal(policy.evaluate('sudo git push origin main', 'bash', snapshot.policy).risk, 'DENY')
        assert.notEqual(policy.evaluate('git status-other', 'bash', snapshot.policy).risk, 'SAFE')
        assert.equal(policy.evaluate('git status; sh -c "echo test"', 'bash', snapshot.policy).risk, 'DANGEROUS')
    })
    await test('only unrestricted mode asks once for explicit acknowledgement', async () => {
        const previous = global.window
        global.window = { localStorage: {} }
        try {
            let calls = 0
            const permissions = new AgentPermissionsService({ config: defaults }, { showMessageBox: async () => ({ response: calls++ ? 1 : 0 }) })
            assert.equal(await permissions.confirmMode('auto'), true)
            assert.equal(await permissions.confirmMode('full'), true)
            assert.equal(await permissions.confirmMode('unrestricted'), false)
            assert.equal(global.window.localStorage.ashUnrestrictedAccessAcknowledged, undefined)
            assert.equal(await permissions.confirmMode('unrestricted'), true)
            assert.equal(await permissions.confirmMode('unrestricted'), true)
            assert.equal(calls, 2)
        } finally { global.window = previous }
    })
    await test('disabling an optional redaction rule retains local secret placeholders', () => {
        const config = { config: { ...defaults, redaction: { enabled: true, patterns: [{ name: 'custom', pattern: 'private-value', replacement: '[CUSTOM]', enabled: false }] } } }
        const redactor = new SecretRedactor(config)
        assert.equal(redactor.redact('private-value'), 'private-value')
        config.config.redaction.patterns[0].enabled = true
        assert.equal(redactor.redact('private-value'), '[CUSTOM]')
        const scope = redactor.createScope()
        const token = scope.register('local-password')
        config.config.redaction.enabled = false
        assert.equal(scope.protect('local-password'), token)
        assert.equal(scope.restore(token), 'local-password')
    })
    await test('readline history survives prompt repaint and forwards editing until submit or cancel', async () => {
        const f = await fixture()
        try {
            await f.type('\x1b[A')
            await f.prompt()
            assert.equal(f.input.canCapture, false)
            await f.type('\x7f\x1b[D\x08')
            assert.equal(f.sent.join(''), '\x1b[A\x7f\x1b[D\x08')
            await f.type('\r')
            await f.prompt()
            assert.equal(f.input.canCapture, true)
            await f.type('\x12')
            await f.prompt()
            await f.type('\x03')
            await f.prompt()
            assert.equal(f.input.canCapture, true)
        } finally { f.close() }
    })
    await test('restored transcript retains commands and output but never replays terminal control sequences', () => {
        const restored = [...historyChunks([
            { type: 'user-ai-input', data: { content: '检查目录' } },
            { type: 'ssh-input', data: { content: 'pwd' } },
            { type: 'ssh-output', data: { content: '\x1b]52;c;PRIVATE' } },
            { type: 'ssh-output', data: { content: '\x07/home/test\r\n\x1b[2J' } },
            { type: 'ai-message', data: { content: '**完成**' } },
        ])].join('')
        assert.match(restored, /检查目录/)
        assert.match(restored, /\$ pwd/)
        assert.match(restored, /\/home\/test/)
        assert.equal(restored.includes('PRIVATE'), false)
        assert.equal(restored.replace(/\x1b\[[\d;]*m/g, '').includes('\x1b'), false)
    })
    await test('Markdown streams identical text and styles across arbitrary chunk boundaries', async () => {
        const source = '# 标题\n正文 **重点** 和 *斜体*、`echo hi`、~~旧项~~。\n- 项目\n> 引用\n```bash\necho "**literal**"\n```\n[链接](https://example.com)\n末尾'
        const render = async parts => {
            const renderer = new TerminalMarkdown(), frontend = new XTermFrontend()
            frontend.xterm.resize(100, 20)
            let output = ''
            for (const part of parts) output += renderer.feed(part)
            output += renderer.finish()
            assert.equal(output.replace(/\x1b\[[\d;]*m/g, '').includes('\x1b'), false)
            await new Promise(resolve => frontend.xterm.write(output + '\r\nSHELL', resolve))
            const rows = Array.from({length:frontend.xterm.buffer.active.length}, (_,y) => {
                const line = frontend.xterm.buffer.active.getLine(y)
                return Array.from({length:100},(_,x)=>{const c=line.getCell(x);return [c.getChars(), c.getFgColor(), c.isBold(), c.isItalic(), c.isStrikethrough()]})
            })
            frontend.xterm.dispose()
            return rows
        }
        const expected = await render([source])
        assert.deepEqual(await render([...source]), expected)
        for (let size = 2; size < 12; size++) {
            const parts=[]; for(let i=0;i<source.length;i+=size) parts.push(source.slice(i,i+size))
            assert.deepEqual(await render(parts), expected)
        }
        assert.equal(expected[0][0][2] !== 0, true)
        assert.equal(expected[1][0][1], 6, 'Agent body should use theme cyan')
        assert.equal(expected.flat().some(cell=>cell[0]==='S' && cell[1]===-1), true, 'Shell color must reset')
        assert.match(terminalMarkdown('text \x1b]52;c;secret\x07safe'), /safe/)
        assert.equal(terminalMarkdown('text \x1b]52;c;secret\x07safe').includes('secret'), false)
    })
    await test('Markdown needs no complete line and retains bounded state for huge input', () => {
        const renderer = new TerminalMarkdown()
        assert.match(renderer.feed('即时输出'), /即时输出/)
        renderer.feed('#'.repeat(100000))
        assert.ok(renderer.prefix.length <= 32)
        assert.equal(terminalMarkdown('末尾 \\'), '\x1b[0;36m末尾 \x1b[0m\x1b[0;36m\\\x1b[0m')
    })
    await test('idle Shell prompt repaint does not insert prompt text into Agent prose', async () => {
        const f = await fixture(), shown = []
        f.integration.outputToTerminal$.subscribe(data => shown.push(data.toString()))
        try {
            f.integration.localPresentation = true
            await f.prompt()
            assert.equal(shown.join('').includes('$ '), false)
            assert.equal(f.integration.promptText, '$ ')
            f.integration.feedFromSession(Buffer.from('background output\r\n'))
            assert.match(shown.join(''), /background output/)
            f.integration.localPresentation = false
            await f.prompt()
            assert.match(shown.join(''), /\$ /)
        } finally { f.close() }
    })
    await test('typing during an idle prompt repaint waits locally instead of leaking to SSH', async () => {
        const f = await fixture()
        try {
            f.integration.feedFromSession(Buffer.from(f.marker('A')))
            f.input.feedFromTerminal(Buffer.from('重绘期间的自然语言'))
            await tick()
            assert.deepEqual(f.sent, [])
            f.integration.feedFromSession(Buffer.from('$ ' + f.marker('B')))
            await f.input.settled()
            assert.deepEqual(f.sent, [])
            await f.type('\r')
            assert.deepEqual(f.agent, ['重绘期间的自然语言'])
        } finally { f.close() }
    })
    await test('multiline shell, continuations, heredocs and mixed prose', () => {
        for (const source of ['ls\npwd', '# comment\nls', 'curl \\\n  https://example.com', "cat <<'EOF'\n这里是内容\nEOF", 'for x in a b; do\n echo "$x"\ndone', 'echo "hello\n世界"', '```bash\nls\npwd\n```']) assert.equal(detector.isShellCommand(source), true, source)
        for (const source of ['帮我检查磁盘', 'ls\n然后解释结果', '检查这个地址 https://example.com?a=b&c=d']) assert.equal(detector.isShellCommand(source), false, source)
        assert.equal(unwrapShellFence('```bash\nls\n```'), 'ls')
    })
    await test('split ANSI/OSC/DCS and C1 model controls never reach xterm', () => {
        const filter = new TerminalTextFilter()
        let visible = ''
        for (const part of ['hello\x1b]', '52;c;SECRET', '\x07world\x1b[', '2J\x1bPpayload\x1b', '\\!\x9b3J\r', '\n中文']) visible += filter.feed(part)
        assert.equal(visible, 'helloworld!\r\n中文')
    })
    await test('Chinese IME input stays local until Enter, then routes once to Agent', async () => {
        const f = await fixture()
        try {
            await f.type('帮我查看日志')
            assert.deepEqual(f.sent, [])
            assert.match(f.frontend.xterm.buffer.active.getLine(0).translateToString(), /帮我查看日志/)
            await f.type('\r')
            assert.deepEqual(f.sent, [])
            assert.deepEqual(f.agent, ['帮我查看日志'])
        } finally { f.close() }
    })
    await test('Shell input is sent exactly once with no Ctrl+U workaround', async () => {
        const f = await fixture()
        try {
            await f.type('echo 中文')
            assert.deepEqual(f.sent, [])
            await f.type('\r')
            assert.deepEqual(f.sent, ['echo 中文\r'])
        } finally { f.close() }
    })
    await test('bracketed multiline paste never submits on paste completion', async () => {
        const f = await fixture()
        try {
            await f.type('\x1b[200~帮我检查\n然后解释\x1b[201~')
            assert.deepEqual(f.sent, []); assert.deepEqual(f.agent, [])
            await f.type('\r')
            assert.deepEqual(f.agent, ['帮我检查\n然后解释'])
        } finally { f.close() }
    })
    await test('clipboard keeps heredoc intact until explicit submit', async () => {
        const f = await fixture()
        try {
            const script = "cat <<'EOF'\n中文\nEOF"
            f.input.pasteText(script); await f.input.settled()
            assert.deepEqual(f.sent, [])
            await f.type('\r')
            assert.deepEqual(f.sent, ['\x1b[200~' + script + '\x1b[201~\r'])
        } finally { f.close() }
    })
    await test('Tab transfers draft and remote editing stays remote until fresh prompt', async () => {
        const f = await fixture()
        try {
            await f.type('git sta'); await f.type('\t'); await f.type('tus\r')
            assert.deepEqual(f.sent, ['git sta\t', 'tus\r'])
            assert.deepEqual(f.agent, [])
            await f.prompt(); await f.type('帮我分析'); await f.type('\r')
            assert.deepEqual(f.agent, ['帮我分析'])
        } finally { f.close() }
    })
    await test('manual routing overrides auto without changing mode', async () => {
        const f = await fixture()
        try {
            await f.type('mytool'); f.input.submit('shell'); await f.input.settled()
            assert.deepEqual(f.sent, ['mytool\r'])
            await f.prompt(); await f.type('git 怎么撤销'); f.input.submit('agent'); await f.input.settled()
            assert.deepEqual(f.agent, ['git 怎么撤销'])
            assert.equal(f.integration.mode.value, 'agent')
        } finally { f.close() }
    })
    await test('original mode and alternate screen preserve exact input bytes', async () => {
        const f = await fixture()
        try {
            f.integration.mode.next('shell'); await f.type('\x1b[A\x12\x03中文\r')
            assert.deepEqual(f.sent, ['\x1b[A\x12\x03中文\r'])
            f.integration.mode.next('agent'); f.integration.setAlternateScreen(true); await f.type('j:q!\r')
            assert.equal(f.sent[1], 'j:q!\r')
        } finally { f.close() }
    })
    await test('only own session markers enable capture; markers can split anywhere', async () => {
        const f = await fixture()
        try {
            f.integration.commandStarted()
            f.integration.feedFromSession(Buffer.from('\x1b]777;ash;wrong;B\x07$ ')); await tick()
            assert.equal(f.integration.ready, false)
            for (const character of f.marker('A') + '$ ' + f.marker('B')) f.integration.feedFromSession(Buffer.from(character))
            await new Promise(resolve => setTimeout(resolve, 60)); await f.runtime.tab.write(''); await tick()
            assert.equal(f.integration.ready, true)
        } finally { f.close() }
    })
    await test('shell identity handles Unix and PowerShell echo formats', () => {
        assert.equal(detectShellKind('__ASH_SHELL__ /bin/bash bash .PSEdition'), 'bash')
        assert.equal(detectShellKind('__ASH_SHELL__\r\nCore\r\n'), 'powershell')
        assert.equal(detectShellKind('__ASH_SHELL__ /bin/fish fish'), 'fish')
        assert.equal(detectShellKind('banner /bin/bash'), null)
        assert.match(shellBootstrap('powershell', 'test'), /FromBase64String/)
    })
    await test('handoff preserves command framing and exit code after abort', async () => {
        const framing = new CommandFramingMiddleware(), sent = [], shown = []
        framing.outputToTerminal$.subscribe(data => shown.push(data.toString()))
        const controller = new AbortController()
        const result = framing.execute('sleep 1', { sendAgent: value => sent.push(value) }, undefined, controller.signal)
        const begin = sent[0].match(/__TABBY_AI_BEGIN_\w+/)[0], end = sent[0].match(/__TABBY_AI_END_\w+/)[0]
        framing.feedFromSession(Buffer.from('\x1b]777;' + begin + '\x07'))
        framing.releaseControl(); controller.abort()
        assert.equal(sent.length, 1)
        for (const character of 'result\r\n\x1b]777;' + end + ':7\x07$ ') framing.feedFromSession(Buffer.from(character))
        assert.equal((await result).exitCode, 7)
        assert.equal(shown.join('').includes('__TABBY_AI_'), false)
        framing.close()
    })
    await test('known secrets never leak across any streaming chunk boundary', () => {
        const redactor = new SecretRedactor({ config: defaults })
        for (const secret of ['sample-secret-123', 'aaaa', 'abcabc', '中文密码']) {
            const scope = redactor.createScope(), placeholder = scope.register(secret)
            for (let split = 1; split < secret.length; split++) {
                const filter = scope.streamFilter()
                const output = filter('prefix ' + secret.slice(0, split)) + filter(secret.slice(split) + ' suffix') + filter.flush()
                assert.equal(output, 'prefix ' + placeholder + ' suffix')
            }
        }
    })
    await test('wide-character drafts survive terminal reflow and erase without duplicate text', async () => {
        const f = await fixture()
        try {
            await f.type('echo ' + '中文'.repeat(18))
            f.frontend.xterm.resize(24, 12)
            await f.type('\x7f')
            f.input.submit('shell'); await f.input.settled()
            assert.equal(f.sent.join(''), 'echo ' + '中文'.repeat(17) + '中\r')
            const screen = Array.from({length: f.frontend.xterm.buffer.active.length}, (_, i) => f.frontend.xterm.buffer.active.getLine(i).translateToString()).join('\n')
            assert.equal(screen.includes('中文'), false)
        } finally { f.close() }
    })
    await test('cancelled commands still hide trailing execution markers', async () => {
        const framing = new CommandFramingMiddleware(), sent = [], shown = []
        const interrupts = []
        framing.outputToSession$.subscribe(data => interrupts.push(data.toString()))
        framing.outputToTerminal$.subscribe(data => shown.push(data.toString()))
        const result = framing.execute('sleep 5', { sendAgent: value => sent.push(value) }).catch(error => error)
        const begin = sent[0].match(/__TABBY_AI_BEGIN_\w+/)[0], end = sent[0].match(/__TABBY_AI_END_\w+/)[0]
        framing.feedFromSession(Buffer.from('\x1b]777;' + begin + '\x07'))
        framing.cancel()
        assert.deepEqual(interrupts, ['\x03'])
        framing.feedFromSession(Buffer.from('\x1b]777;' + end + ':130\x07$ '))
        assert.equal((await result).name, 'AbortError')
        assert.equal(shown.join('').includes('__TABBY_AI_'), false)
        framing.close()
    })
    await test('queued text following Agent submission never falls through to SSH', async () => {
        const f = await fixture()
        try {
            f.input.feedFromTerminal(Buffer.from('帮我分析\r'))
            f.input.feedFromTerminal(Buffer.from('这段文字也不能泄露'))
            await f.input.settled()
            assert.deepEqual(f.agent, ['帮我分析'])
            assert.deepEqual(f.sent, [])
        } finally { f.close() }
    })
    await test('failure unloads at a confirmed prompt, defers cleanup while remote owns input', async () => {
        for (const running of [false, true]) {
            const f = await fixture(), cleanup = []
            f.integration.outputToSession$.subscribe(data => cleanup.push(data.toString()))
            try {
                if (running) f.integration.commandStarted()
                f.integration.fail('test failure')
                assert.equal(f.integration.mode.value, 'shell')
                assert.equal(cleanup.length, running ? 0 : 1)
                if (running) await f.prompt()
                assert.deepEqual(cleanup, [' __ash_uninstall\r'])
                assert.equal(f.input.canCapture, false)
                f.integration.feedFromSession(Buffer.from(f.marker('U')))
                assert.equal(f.integration.installed, false)
            } finally { f.close() }
        }
    })
    await test('rapid mode toggle waits for uninstall acknowledgement before reinstalling', async () => {
        const f = await fixture()
        try {
            f.integration.disable(); f.integration.enable()
            assert.equal(f.input.canCapture, false)
            f.integration.feedFromSession(Buffer.from(f.marker('U')))
            assert.equal(f.integration.mode.value, 'agent')
            assert.equal(f.integration.state.value, 'initializing')
        } finally { f.close() }
    })
    await test('presenter drains its last batch before handoff and releases failed presentations', async () => {
        const { AgentTerminalPresenter } = load('tabby-ai/src/terminal/agent-terminal-presenter.ts')
        const f = await fixture()
        let fail = false
        const presenter = new AgentTerminalPresenter({ waitForPrompt: async () => { if (fail) throw new Error('closed') }, isExecuting: () => false, setLocalPresentation: () => {} })
        try {
            await presenter.open(f.runtime, 'one')
            f.runtime.liveText.next('最后一批回答')
            await presenter.interrupt('one')
            const text = Array.from({length:f.frontend.xterm.buffer.active.length}, (_,i)=>f.frontend.xterm.buffer.active.getLine(i).translateToString()).join('\n')
            assert.match(text, /最后一批回答/)
            fail = true
            await assert.rejects(presenter.finish('one'))
            assert.equal(presenter.runs.size, 0)
        } finally { presenter.detachSession(f.runtime.id); f.close() }
    })
    console.log(count + ' native Agent checks passed')
}
module.exports = { load, XTermFrontend, detector, tick }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
