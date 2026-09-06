/* Isolated Electron + real SSH smoke test. Run through test-native-agent-docker.cjs. */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const WebSocket = require('../node_modules/ws')
const yaml = require('../tabby-ai/node_modules/js-yaml')
const root = path.resolve(__dirname, '..')
if (!process.env.ASH_TEST_SSH_PORT || !process.env.ASH_TEST_PASSWORD) throw new Error('Run through test-native-agent-docker.cjs')
const testShell = process.env.ASH_TEST_SHELL || 'bash'
const directory = path.join(root, '.build-cache', 'native-agent-ui-' + Date.now())
fs.mkdirSync(path.join(directory, 'tabby-ai'), { recursive: true })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const requests = []
const model = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(body)
    const messages = JSON.parse(body).messages
    const lastUser = messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
    const toolDone = messages.at(-1)?.role === 'tool'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta = value => res.write('data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n')
    if (lastUser.includes('停止测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'stop-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: "sleep 20", reason: '验证停止按钮中断当前测试进程' }) } }] })
    } else if (lastUser.includes('接管测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'handoff-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: "printf 'HANDOFF_STARTED\\n'; sleep 2; printf 'HANDOFF_DONE\\n'", reason: '验证切换后远端命令继续完成' }) } }] })
    } else if (lastUser.includes('审批测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'local-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: "printf 'APPROVAL_OK\\n'", reason: '本地审批验证：输出测试标记' }) } }] })
    } else if (lastUser.includes('敏感输入测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'secret-test', type: 'function', function: { name: 'request_user_input', arguments: JSON.stringify({ prompt: '请输入测试 Token（仅用于本地验证）', kind: 'secret' }) } }] })
    } else {
        for (const text of ['## 当前终端工作正常。\n', 'Agent 回答与 Shell 输出使用**同一份终端历史**。\n', '- 中文、多行文本和复制均由 xterm 处理。\n', '> 这里只用终端字符呈现。\n', '```bash\necho "native markdown"\n```\n']) {
            delta({ content: text }); await delay(50)
        }
    }
    res.end('data: [DONE]\n\n')
})
let electron, socket
async function main () {
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    const config = yaml.load(fs.readFileSync(path.join(root, 'tabby-ai/default-config.yaml'), 'utf8'))
    config.llm.baseURL = 'http://127.0.0.1:' + model.address().port + '/v1'
    config.llm.model = 'isolated-test'
    fs.writeFileSync(path.join(directory, 'tabby-ai/config.yaml'), yaml.dump(config))
    fs.writeFileSync(path.join(directory, 'config.yaml'), yaml.dump({ version: 7, enableAnalytics: false, terminal: { frontend: 'xterm', fontSize: 16 }, appearance: { colorScheme: 'dark' }, ssh: { verifyHostKeys: false }, recovery: [] }))
    const debug = http.createServer()
    await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve))
    const port = debug.address().port
    await new Promise(resolve => debug.close(resolve))
    const log = fs.openSync(path.join(directory, 'electron.log'), 'w')
    electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'app'), '--remote-debugging-port=' + port], {
        cwd: root, windowsHide: true, stdio: ['ignore', log, log],
        env: { ...process.env, TABBY_DEV: '1', TABBY_DATA_DIRECTORY: directory, TABBY_CONFIG_DIRECTORY: directory },
    })
    let target
    for (let tries = 0; tries < 100; tries++) {
        try { target = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(item => item.type === 'page'); if (target) break } catch {}
        await delay(200)
    }
    if (!target) throw new Error('Electron did not expose its test page; see ' + directory)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise(resolve => socket.once('open', resolve))
    let id = 0
    const waiting = new Map()
    socket.on('message', data => {
        const message = JSON.parse(data)
        if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
        if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled') {
            fs.appendFileSync(path.join(directory, 'renderer.log'), JSON.stringify(message) + '\n')
        }
    })
    const call = async (method, params = {}) => {
        const current = ++id
        const response = new Promise(resolve => waiting.set(current, resolve))
        socket.send(JSON.stringify({ id: current, method, params }))
        const message = await response
        if (message.error) throw new Error(JSON.stringify(message.error))
        return message.result
    }
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
        return result.result?.value
    }
    await call('Runtime.enable')
    const wait = async (expression, label) => {
        for (let attempt = 0; attempt < 150; attempt++) {
            if (await evaluate(expression)) return
            await delay(100)
        }
        fs.writeFileSync(path.join(directory, 'failure.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
        console.error(await evaluate('(async()=>{const a=ng.getComponent(document.querySelector("ash-agent-dock"))?.terminal.attachments.get(nativeTest);return JSON.stringify({identity:await window.nativeTest?.sshSession?.probeShell().catch(String), kind:a?.integration.kind, recent:a?.integration.recent, installed:a?.integration.installed, sentBootstrap:a?.integration.sentBootstrap, framing:a?.framing.pending?.buffer})})()'))
        throw new Error('Timed out: ' + label + '; ' + await evaluate('document.body.innerText.slice(-2000)'))
    }
    await wait('!!window.ng?.getComponent?.(document.querySelector("app-root"))?.ready', 'Angular bootstrap')
    await evaluate(`(async () => {
        const core = require('tabby-core'), ssh = require('tabby-ssh')
        const appRoot = ng.getComponent(document.querySelector('app-root'))
        const injector = ng.getInjector(document.querySelector('app-root'))
        const profiles = injector.get(core.ProfilesService)
        const profile = profiles.getConfigProxyForProfile({ id: 'native-agent-test', type: 'ssh', name: 'Native Agent · Local QA', options: { host: '127.0.0.1', user: 'ash${testShell}', port: ${Number(process.env.ASH_TEST_SSH_PORT)}, auth: 'password', password: ${JSON.stringify(process.env.ASH_TEST_PASSWORD)}, reuseSession: false }, clearServiceMessagesOnConnect: false })
        injector.get(core.NgZone ?? require('@angular/core').NgZone).run(() => {
            window.nativeTest = appRoot.app.openNewTab({ type: ssh.SSHTabComponent, inputs: { profile } })
        })
        window.nativeTestInjector = injector
        return true
    })()`)
    await wait('!!document.querySelector("ash-agent-dock") && !!ng.getComponent(document.querySelector("ash-agent-dock"))?.runtime.terminal.value.ready', 'local Shell integration')
    const send = text => evaluate('(async () => { nativeTest.sendInput(' + JSON.stringify(text) + '); await ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).input.settled(); return true })()')
    const screen = async name => {
        await delay(150)
        const result = await call('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'))
    }
    await send('echo "Shell 与 Agent 共用原生终端"\r')
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.terminal.value.ready', 'command prompt')
    await evaluate('nativeTest.testWrites=[]; const original=nativeTest.session.write.bind(nativeTest.session); nativeTest.session.write=data=>{nativeTest.testWrites.push(data.toString());original(data)}; true')
    const writes = await evaluate('nativeTest.testWrites.length')
    await send('帮我检查当前终端')
    assert.equal(await evaluate('nativeTest.testWrites.slice(' + writes + ').filter(text => !/^\\x1b\\[(?:[IO]|[?>]?[\\d;]*[cR])$/.test(text)).join("")'), '', 'Draft reached SSH before Enter')
    await send('\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId && ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value === "DONE"', 'Agent response')
    const terminalText = () => evaluate('Array.from({length:nativeTest.frontend.xterm.buffer.active.length},(_,i)=>nativeTest.frontend.xterm.buffer.active.getLine(i).translateToString()).join("\\n")')
    assert.match(await terminalText(), /当前终端工作正常/)
    await screen('native-output')
    await send('审批测试\r')
    await wait('!!document.querySelector("ash-agent-dock textarea")', 'approval Dock')
    const geometry = await evaluate(`(() => { const a=document.querySelector('ssh-tab > .content').getBoundingClientRect(),b=document.querySelector('ash-agent-dock').getBoundingClientRect(); return {terminalBottom:a.bottom,dockTop:b.top,terminalHeight:a.height,dockHeight:b.height} })()`)
    assert.ok(geometry.terminalBottom <= geometry.dockTop + 1, 'Dock overlaps terminal')
    await screen('approval-dock')
    await evaluate('document.querySelector("ash-agent-dock .btn-primary").click(); true')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId', 'approved command')
    assert.match(await terminalText(), /APPROVAL_OK/)
    assert.match(await terminalText(), /当前终端工作正常/, 'Answer lost when approval Dock resized terminal')
    await send('敏感输入测试\r')
    await wait('!!document.querySelector("ash-agent-dock input[type=password]")', 'sensitive form')
    await screen('sensitive-dock')
    await evaluate('const secret=document.querySelector("ash-agent-dock input[type=password]"); secret.value="NATIVE_QA_SECRET_123456"; secret.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("ash-agent-dock .interaction .btn-primary").click(); true')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId', 'secret form response')
    assert.equal(requests.join('').includes('NATIVE_QA_SECRET_123456'), false, 'Secret reached model')
    assert.ok(requests.join('').includes('__TABBY_SENSITIVE_1__'), 'Secret placeholder was not provided to model')
    const ready = () => wait('!!ng.getComponent(document.querySelector("ash-agent-dock"))?.terminal.attachments.get(nativeTest)?.input.canCapture', 'fresh prompt')
    await ready()
    await evaluate('nativeTest.frontend.focus(); true')
    await call('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 })
    await call('Input.insertText', { text: '中文输入' })
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).input.buffer === "中文输入"', 'IME commit')
    await send('\x15')
    const forceAgent = 'echo 这次强制给 Agent'
    await send(forceAgent)
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.events.value.some(event => event.type === "user-ai-input" && event.data.content === "echo 这次强制给 Agent")', 'Shift Enter routes to Agent')
    await ready()
    const beforeShell = requests.length
    await send('ash_test_unknown_command')
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 })
    await wait('nativeTest.testWrites.some(text => text.includes("ash_test_unknown_command"))', 'Ctrl Enter routes to Shell')
    await ready()
    assert.equal(requests.length, beforeShell)
    // Shell programs retain their original input and fullscreen handling.
    for (const [command, exit] of [['vim -Nu NONE -n', ':q!\r'], ['less /etc/services', 'q'], ['top', 'q']]) {
        await ready(); await send(command + '\r')
        await wait(command === 'top'
            ? 'Array.from({length:nativeTest.frontend.xterm.buffer.active.length},(_,i)=>nativeTest.frontend.xterm.buffer.active.getLine(i).translateToString()).some(line => /Tasks:|Mem:/.test(line))'
            : 'nativeTest.frontend.xterm.buffer.active.type === "alternate"', command + ' running')
        await send(exit); await ready()
    }
    await send('echo HISTORY_CHECK\r'); await ready()
    await send('\x1b[A'); await send('\r'); await ready()
    assert.ok((await terminalText()).split('HISTORY_CHECK').length >= 3, 'History recall did not execute')
    await send('echo COMPLETION_CHECK'); await send('\t'); await send('\r'); await ready()
    await send("sh -c 'sleep .4; printf \"\\nASYNC_OUTPUT\\n\"' &\r"); await ready()
    await send('异步输出期间保留本地输入')
    await delay(600)
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).input.buffer'), '异步输出期间保留本地输入')
    await send('\x15')
    // Exercise actual resize while a wide-character draft is held locally.
    const draft = 'echo ' + '中文'.repeat(20)
    await send(draft)
    await evaluate('require("@electron/remote").getCurrentWindow().setSize(760,620); true')
    await delay(250)
    await send('\r'); await ready()
    assert.equal((await evaluate('nativeTest.testWrites.join("")')).includes(draft), true)
    // A new connection to the same tab must reinstall markers and accept Agent input.
    await evaluate('nativeTest.disconnect()')
    await delay(200)
    await evaluate('nativeTest.reconnect()')
    await ready()
    await send('重连后测试\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId && ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value === "DONE"', 'Agent after reconnect')
    await send('停止测试\r')
    await wait('!!document.querySelector("ash-agent-dock textarea")', 'stop test approval')
    await evaluate('document.querySelector("ash-agent-dock .btn-primary").click(); true')
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).framing.pending?.started', 'stop test running')
    await evaluate('document.querySelector("ash-agent-dock .stop-button").click(); true')
    await ready()
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value'), 'CANCELLED')
    await send('接管测试\r')
    await wait('!!document.querySelector("ash-agent-dock textarea")', 'handoff command approval')
    await evaluate('document.querySelector("ash-agent-dock .btn-primary").click(); true')
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).framing.pending?.started', 'handoff command started')
    await evaluate('document.querySelector("ash-agent-dock .mode-button").click(); true')
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.terminal.value.mode === "shell"', 'original mode')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).integration.installed', 'script unload')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId', 'handoff completed')
    assert.match(await terminalText(), /HANDOFF_DONE/)
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.events.value.some(event => event.type === "command-result" && event.data.handedOff && event.data.exitCode === 0)'), true)
    await screen('original-mode')
    console.log('PASS Electron + SSH (' + testShell + '): input privacy, native output, approval, sensitive Dock, original mode')
    console.log('Screenshots and isolated data:', directory)
    fs.writeFileSync(path.join(root, '.build-cache/native-agent-ui-latest.txt'), directory)
    await evaluate('nativeTest.session.destroy(); true')
    await delay(300)
    void evaluate('require("@electron/remote").app.exit(0)')
}
const timeout = setTimeout(() => { console.error('UI test timed out:', directory); socket?.close(); electron?.kill(); model.close(); process.exitCode = 1 }, 150000)
main().catch(error => { console.error(error); console.error('Test data:', directory); process.exitCode = 1 }).finally(() => {
    clearTimeout(timeout); socket?.close(); electron?.kill(); model.close()
})
