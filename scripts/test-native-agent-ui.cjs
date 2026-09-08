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
    const request = JSON.parse(body)
    const messages = request.messages
    const lastUser = messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
    const toolDone = messages.at(-1)?.role === 'tool'
    if (!request.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
        return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta = value => res.write('data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n')
    if (request.tools?.[0]?.function.name === 'ash_connection_check') {
        if (toolDone) { delta({ content: JSON.parse(messages.at(-1).content).value }) }
        else { delta({ tool_calls: [{ index: 0, id: 'compatibility-check', type: 'function', function: { name: 'ash_connection_check', arguments: '{"text":"ash-check"}' } }] }) }
    } else if (lastUser.includes('删除卷审批测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'destructive-guard-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: 'docker compose down -v', reason: '验证删除卷必须二次确认；测试会拒绝执行' }) } }] })
    } else if (lastUser.includes('凭据边界测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'credential-guard-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: 'grep MYSQL_ROOT_PASSWORD .env', reason: '验证凭据读取被本地拦截' }) } }] })
    } else if (lastUser.includes('停止测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'stop-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: "sleep 20", reason: '验证停止按钮中断当前测试进程' }) } }] })
    } else if (lastUser.includes('接管测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'handoff-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: "printf 'HANDOFF_STARTED\\n'; sleep 2; printf 'HANDOFF_DONE\\n'", reason: '验证切换后远端命令继续完成' }) } }] })
    } else if (lastUser.includes('审批测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'local-test', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: "printf 'APPROVAL_OK\\n'", reason: '本地审批验证：输出测试标记' }) } }] })
    } else if (lastUser.includes('敏感输入测试') && !toolDone) {
        delta({ tool_calls: [{ index: 0, id: 'secret-test', type: 'function', function: { name: 'request_user_input', arguments: JSON.stringify({ prompt: '请输入测试 Token（仅用于本地验证）', kind: 'secret' }) } }] })
    } else if (toolDone && JSON.parse(messages.at(-1).content).status === 'rejected') {
        delta({ content: '命令未执行，我会根据已有信息继续分析。REJECTION_CONTINUED\n' })
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
    // This process has a unique userData directory. Avoid forwarding QA startup
    // to an already running portable app or registering its URL protocol.
    const bootstrap = path.join(directory, 'bootstrap.cjs')
    fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.join(root, 'app'))});app.requestSingleInstanceLock=()=>true;app.setAsDefaultProtocolClient=()=>false;require(${JSON.stringify(path.join(root, 'app/dist/main.js'))});`)
    electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, '--remote-debugging-port=' + port], {
        cwd: root, windowsHide: true, stdio: ['ignore', log, log],
        env: { ...process.env, TABBY_DEV: '1', TABBY_DATA_DIRECTORY: directory, TABBY_CONFIG_DIRECTORY: directory },
    })
    let target
    for (let tries = 0; tries < 300; tries++) {
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
        injector.get(core.ConfigService).store.profiles.push(JSON.parse(JSON.stringify(profile)))
        await injector.get(core.ConfigService).save()
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
    // Reuse production sidebar components against the disposable SSH server.
    const inZone = code => evaluate('(async()=>{const zone=nativeTestInjector.get(require("@angular/core").NgZone);return await zone.run(async()=>{' + code + '})})()')
    // Two live SSH tabs, deliberately restored from the same transcript id.
    await inZone(`
        const app=nativeTestInjector.get(require('tabby-core').AppService)
        const profile=JSON.parse(JSON.stringify(nativeTest.profile))
        profile.name='Second SSH · Isolation QA'
        window.secondSSH=app.openNewTab({type:require('tabby-ssh').SSHTabComponent,inputs:{profile,aiSessionId:nativeTest.aiSessionId}})
        return true
    `)
    await wait('!!secondSSH.element.nativeElement.querySelector("ash-agent-dock") && ng.getComponent(secondSSH.element.nativeElement.querySelector("ash-agent-dock")).runtime.terminal.value.ready', 'second SSH dock ready')
    await evaluate(`
        window.firstDock=ng.getComponent(nativeTest.element.nativeElement.querySelector('ash-agent-dock'))
        window.secondDock=ng.getComponent(secondSSH.element.nativeElement.querySelector('ash-agent-dock'))
        nativeTest.sendInput('审批测试\\r')
        secondSSH.sendInput('敏感输入测试\\r')
        true
    `)
    await wait('firstDock.requests.length===1 && secondDock.forms.length===1', 'independent approval and password forms')
    assert.equal(await evaluate('firstDock.forms.length===0 && secondDock.requests.length===0 && firstDock.runtime.connectionId!==secondDock.runtime.connectionId && firstDock.runtime.id!==secondDock.runtime.id'), true)
    await wait('!!secondSSH.element.nativeElement.querySelector("input[type=password]")', 'second SSH form rendered')
    assert.equal(await evaluate('!secondSSH.element.nativeElement.querySelector("ash-agent-dock textarea") && !nativeTest.element.nativeElement.querySelector("ash-agent-dock input[type=password]")'), true, 'Foreign interaction rendered in SSH window')
    await screen('ssh-window-isolation')
    await inZone(`
        const request=firstDock.requests[0]
        secondDock.approve(request)
        secondDock.reject(request)
        firstDock.submitForm(secondDock.forms[0])
        return true
    `)
    assert.equal(await evaluate('firstDock.requests.length===1 && secondDock.forms.length===1'), true, 'Cross-window action resolved an unrelated request')
    await inZone('secondDock.submitForm(secondDock.forms[0],false);return true')
    await wait('!secondDock.runtime.activeRunId', 'cancel second SSH input')
    assert.equal(await evaluate('firstDock.requests.length'), 1, 'Cancelling second connection removed first approval')
    await inZone('firstDock.reject(firstDock.requests[0]);return true')
    await wait('!firstDock.runtime.activeRunId', 'cancel first SSH approval')
    assert.equal(await evaluate('firstDock.runtime.state.value'), 'DONE', 'Command rejection stopped the Agent')
    assert.equal(await evaluate('firstDock.runtime.events.value.some(e=>e.type==="ai-message" && e.data.content.includes("REJECTION_CONTINUED"))'), true, 'Agent did not continue thinking after rejection')
    await inZone('await nativeTestInjector.get(require("tabby-core").AppService).closeTab(secondSSH.parent ?? secondSSH);return true')
    await wait('!secondSSH.element.nativeElement.querySelector("ash-agent-dock")', 'second dock removed independently')
    assert.equal(await evaluate('!!nativeTest.element.nativeElement.querySelector("ash-agent-dock")'), true)
    await ready()
    const editWrites = await evaluate('nativeTest.testWrites.length')
    await send('帮我检查配错置')
    await send('\x1b[D\x7f\x1b[H')
    await send('请')
    assert.equal(await evaluate('(()=>{const input=ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).input;return nativeTest.frontend.xterm.buffer.active.cursorX-input.anchorColumn})()'), 2, 'Visible cursor did not follow local draft editing')
    await screen('edited-agent-draft')
    assert.equal(await evaluate('nativeTest.testWrites.slice(' + editWrites + ').filter(text => !/^\\x1b\\[(?:[IO]|[?>]?[\\d;]*[cR])$/.test(text)).join("")'), '', 'Cursor editing leaked draft to SSH')
    await send('\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId', 'edited Agent request')
    assert.ok(requests.some(body => JSON.parse(body).messages.some(message => message.role === 'user' && message.content === '请帮我检查配置')))
    await ready()
    await inZone('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.approvalMode="full";return true')
    await send('凭据边界测试\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId', 'credential guard in full mode')
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.events.value.some(e=>e.type==="ssh-input" && e.data.source==="ai" && e.data.content.includes(".env"))'), false, 'Credential read bypassed full mode guard')
    assert.ok(requests.some(body => JSON.parse(body).messages.some(message => message.role === 'tool' && message.tool_call_id === 'credential-guard-test' && JSON.parse(message.content).error.includes('request_user_input'))))
    await ready()
    const destructiveWrites = await evaluate('nativeTest.testWrites.length')
    await send('删除卷审批测试\r')
    await wait('!!document.querySelector("ash-agent-dock textarea")', 'destructive approval')
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).requests[0].confirmationsRequired'), 2)
    await evaluate('document.querySelector("ash-agent-dock .btn-primary").click();true')
    await delay(150)
    assert.equal(await evaluate('!!document.querySelector("ash-agent-dock textarea")'), true, 'First confirmation executed destructive command')
    await screen('destructive-second-confirmation')
    await evaluate('document.querySelector("ash-agent-dock .interaction .btn-secondary").click();true')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId', 'destructive command rejected')
    assert.equal(await evaluate('nativeTest.testWrites.slice(' + destructiveWrites + ').some(text=>text.includes("ZG9ja2VyIGNvbXBvc2UgZG93biAtdg=="))'), false)
    await inZone('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.approvalMode=undefined;return true')
    await ready()
    await inZone('ng.getComponent(document.querySelector("workspace-sidebar")).select("files");return true')
    await wait('!!ng.getComponent(document.querySelector("sftp-panel"))?.fileList', 'SFTP sidebar connected')
    assert.equal(await inZone(`
        const sidebar=ng.getComponent(document.querySelector('workspace-sidebar'))
        const panel=ng.getComponent(document.querySelector('sftp-panel'))
        const app=nativeTestInjector.get(require('tabby-core').AppService)
        for(let i=0;i<5;i++) { app.getParentTab(nativeTest).focus(nativeTest); sidebar.select('files') }
        return panel===ng.getComponent(document.querySelector('sftp-panel'))
    `), true, 'Repeated terminal focus rebuilt SFTP')
    await inZone('ng.getComponent(document.querySelector("workspace-files")).setFollow(true);return true')
    await send('cd /tmp\r'); await ready()
    await wait('ng.getComponent(document.querySelector("sftp-panel"))?.path === "/tmp"', 'SFTP follows Shell cwd')
    await inZone('ng.getComponent(document.querySelector("workspace-files")).setFollow(false);return true')
    await send('cd /etc\r'); await ready(); await delay(650)
    assert.equal(await evaluate('ng.getComponent(document.querySelector("sftp-panel")).path'), '/tmp', 'Disabled follow changed SFTP path')
    await inZone('await ng.getComponent(document.querySelector("workspace-files")).jump();return true')
    await wait('ng.getComponent(document.querySelector("sftp-panel"))?.path === "/etc"', 'manual cwd jump')
    const sftpGeometry = await evaluate('(()=>{const panel=document.querySelector("sftp-panel");return {header:panel.querySelector(".header").getBoundingClientRect().bottom,body:panel.querySelector(".body").getBoundingClientRect().top}})()')
    assert.ok(sftpGeometry.header <= sftpGeometry.body + 1, 'SFTP toolbar overlaps file list')
    await screen('sidebar-files')
    await inZone('await ng.getComponent(document.querySelector("sftp-panel")).navigate("/ash-path-does-not-exist");return true')
    assert.equal(await evaluate('ng.getComponent(document.querySelector("sftp-panel")).path'), '/etc', 'Failed navigation lost previous directory')
    await inZone('nativeTestInjector.get(require("ngx-toastr").ToastrService).clear();return true')
    await inZone(`
        ng.getComponent(document.querySelector('workspace-sidebar')).select('servers')
        const modals=nativeTestInjector.get(require('@ng-bootstrap/ng-bootstrap').NgbModal)
        const open=modals.open.bind(modals)
        modals.open=(...args)=>{modals.open=open;return window.nativeTestGroupModal=open(...args)}
        return true
    `)
    await wait('!!document.querySelector("profile-tree")', 'server tree')
    await inZone('void ng.getComponent(document.querySelector("profile-tree")).newGroup();return true')
    await wait('!!window.nativeTestGroupModal', 'new group editor')
    await inZone('nativeTestGroupModal.componentInstance.group.name="QA 空分组";await nativeTestGroupModal.componentInstance.save();return true')
    await wait('ng.getComponent(document.querySelector("profile-tree")).profileGroups.some(g=>g.name==="QA 空分组")', 'empty group persisted')
    await inZone(`
        const tree=ng.getComponent(document.querySelector('profile-tree'))
        const profile=(await nativeTestInjector.get(require('tabby-core').ProfilesService).getProfiles()).find(p=>p.id==='native-agent-test')
        await tree.moveProfile(profile,tree.profileGroups.find(g=>g.name==='QA 空分组').id)
        return true
    `)
    await wait('ng.getComponent(document.querySelector("profile-tree")).profileGroups.some(g=>g.name==="QA 空分组" && g.profiles.some(p=>p.id==="native-agent-test"))', 'server moved into group')
    await inZone('ng.getComponent(document.querySelector("workspace-sidebar")).select("agent");return true')
    await wait('!!ng.getComponent(document.querySelector("agent-history"))?.entries.length', 'Agent history list')
    const oldContext = await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.id')
    await inZone('const history=ng.getComponent(document.querySelector("agent-history"));history.startRename(history.entries.find(e=>e.id===' + JSON.stringify(oldContext) + '));history.renameText="我的排障记录";await history.rename();return true')
    await wait('ng.getComponent(document.querySelector("agent-history")).entries.some(e=>e.title==="我的排障记录")', 'custom session title persisted')
    await inZone('const history=ng.getComponent(document.querySelector("agent-history"));await history.inspect(history.entries.find(e=>e.id===' + JSON.stringify(oldContext) + '));return true')
    assert.match(await evaluate('ng.getComponent(document.querySelector("agent-history")).preview'), /帮我检查当前终端/)
    await inZone('await ng.getComponent(document.querySelector("agent-history")).load();return true')
    assert.notEqual(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.id'), oldContext)
    await send('新的独立会话测试\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId && ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value === "DONE"', 'new context response')
    assert.equal(JSON.parse(requests.at(-1)).messages.some(message => message.content?.includes('帮我检查当前终端')), false, 'New context inherited old conversation')
    await inZone('const history=ng.getComponent(document.querySelector("agent-history"));await history.load(history.entries.find(e=>e.id===' + JSON.stringify(oldContext) + '));return true')
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.id'), oldContext)
    await send('恢复上下文测试\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId && ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value === "DONE"', 'restored context response')
    assert.ok(JSON.parse(requests.at(-1)).messages.some(message => message.content?.includes('帮我检查当前终端')), 'Restored context missing from model request')
    await screen('sidebar-history')
    await inZone('ng.getComponent(document.querySelector("workspace-sidebar")).toggle();return true')
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
    await send('echo EDIT_HISTORY_KEEPX\r'); await ready()
    await send('\x1b[A'); await delay(250)
    await send('\x7f\r'); await ready()
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.events.value.some(e=>e.type==="ssh-input" && e.data.content.trim()==="echo EDIT_HISTORY_KEEP")', 'history deletion recorded exact executed command')
    await send('echo READLINE_KEEPX'); await send('\x01'); await delay(250)
    await send('\x05\x7f\r'); await ready()
    await wait('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.events.value.some(e=>e.type==="ssh-input" && e.data.content.trim()==="echo READLINE_KEEP")', 'readline shortcut deletion')
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
    await send('echo REPLAY_SIDE_EFFECT >> /tmp/ash-replay-' + testShell + '\r')
    await delay(500)
    const requestsBeforeReopen = requests.length
    await inZone(`
        const app=nativeTestInjector.get(require('tabby-core').AppService)
        await app.closeTab(app.getParentTab(nativeTest))
        ng.getComponent(document.querySelector('workspace-sidebar')).select('agent')
        return true
    `)
    await wait('document.querySelector("agent-history") && !!ng.getComponent(document.querySelector("agent-history"))?.entries.length', 'history after terminal closed')
    await inZone('const history=ng.getComponent(document.querySelector("agent-history"));await history.open(history.entries.find(e=>e.id===' + JSON.stringify(oldContext) + '));window.nativeTest=history.sessions.find(' + JSON.stringify(oldContext) + ')?.tab;return true')
    await wait('document.querySelector("ash-agent-dock") && !!ng.getComponent(document.querySelector("ash-agent-dock"))?.runtime', 'history SSH tab opened')
    await evaluate('window.nativeTest=ng.getComponent(document.querySelector("ash-agent-dock")).runtime.tab;true')
    await ready()
    await screen('history-reopened')
    assert.match(await terminalText(), /历史记录（仅展示）/)
    assert.match(await terminalText(), /EDIT_HISTORY_KEEP/)
    assert.match(await terminalText(), /当前终端工作正常/)
    assert.match(await terminalText(), /本次连接/)
    assert.equal(requests.length, requestsBeforeReopen, 'History replay started an Agent run')
    await send('wc -l < /tmp/ash-replay-' + testShell + '\r'); await ready(); await delay(500)
    const tail = (await terminalText()).trim().split('\n').slice(-6).join('\n')
    assert.match(tail, /(?:^|\n)\s*1\s*(?:\n|$)/, 'History replay executed an old Shell command')
    await screen('history-reopened')
    // Use the actual Angular settings page, isolated configuration and native Dock.
    await inZone(`
        const dock=ng.getComponent(document.querySelector('ash-agent-dock'))
        window.qaSessionStore=dock.store
        window.qaSessionId=dock.runtime.id
        const fs=require('fs')
        window.qaAppendFile=fs.promises.appendFile
        const file=dock.store.getSessionPath(qaSessionId)
        fs.promises.appendFile=async (...args)=>{
            if(args[0]===file) throw Object.assign(new Error('QA storage failure'),{code:'ENOSPC'})
            return qaAppendFile(...args)
        }
        await dock.store.append(qaSessionId,'ssh-output',{content:'QA_PERSISTENCE_RETRY'})
        return true
    `)
    await wait('document.querySelector("ash-agent-dock").innerText.includes("仅保存在内存中")', 'storage failure visible in Dock')
    await screen('storage-retry-notice')
    await inZone('require("fs").promises.appendFile=qaAppendFile;await qaSessionStore.retrySaving();return true')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).store.persistence.value.error', 'storage retry clears notice')
    assert.equal(await evaluate('(async()=> (await qaSessionStore.read(qaSessionId)).some(e=>e.data.content==="QA_PERSISTENCE_RETRY"))()'), true)
    await evaluate('require("@electron/remote").getCurrentWindow().setSize(1280,800); true')
    await inZone(`
        const app=nativeTestInjector.get(require('tabby-core').AppService)
        window.qaSettingsTab=app.openNewTab({type:require('tabby-settings').SettingsTabComponent,inputs:{activeTab:'ai'}})
        return true
    `)
    await wait('document.querySelector("ash-ai-settings") && !!ng.getComponent(document.querySelector("ash-ai-settings"))?.model', 'AI settings rendered')
    const commandCountBeforeCheck = await evaluate('nativeTest.testWrites?.length || 0')
    await inZone('void ng.getComponent(document.querySelector("ash-ai-settings")).testConnection();return true')
    await wait('!ng.getComponent(document.querySelector("ash-ai-settings")).testing && ng.getComponent(document.querySelector("ash-ai-settings")).modelChecks.length===4', 'model capability check completed')
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-ai-settings")).modelChecks.every(check=>check.state==="passed")'), true)
    assert.equal(await evaluate('nativeTest.testWrites?.length || 0'), commandCountBeforeCheck)
    await evaluate('document.querySelector("ash-ai-settings .model-checks").scrollIntoView({block:"center"});true')
    await delay(150)
    await screen('ai-model-check')
    assert.equal(await evaluate('!!document.querySelector("settings-tab .fa-wand-magic-sparkles")'), true)
    assert.equal(await inZone(`
        const s=ng.getComponent(document.querySelector('ash-ai-settings'))
        window.qaAISettings=s
        window.qaOriginalAIConfig=JSON.parse(JSON.stringify(s.configService.config))
        s.section='input'
        s.shellCommands+=String.fromCharCode(10)+'qa_custom_shell'
        s.previewCommand='qa_custom_shell --version'
        s.preview()
        await s.save()
        return s.configService.config.inputDetection.shellCommands.includes('qa_custom_shell') &&
            JSON.stringify(s.configService.config.inputDetection.shellPatterns)===JSON.stringify(qaOriginalAIConfig.inputDetection.shellPatterns) && s.previewResult.includes('Shell')
    `), true)
    await screen('ai-settings-input')
    assert.equal(await inZone(`
        const s=qaAISettings
        await s.restoreDefaults()
        s.section='policy'
        s.model.policy.approvalMode='auto'
        s.addRule()
        Object.assign(s.model.policy.commandRules.at(-1),{command:'printf',risk:'MODIFY'})
        await s.save()
        return s.configService.config.policy.approvalMode==='auto' && s.model.llm.apiKey===qaOriginalAIConfig.llm.apiKey
    `), true)
    await screen('ai-settings-permissions')
    await inZone('await nativeTestInjector.get(require("tabby-core").AppService).closeTab(qaSettingsTab);return true')
    await ready()
    await send('审批测试\r')
    await wait('!!document.querySelector("ash-agent-dock textarea")', 'auto mode still requires modification approval')
    await evaluate('document.querySelector("ash-agent-dock .btn-primary").click();true')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId && ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value === "DONE"', 'approved modification completed')
    assert.equal(await evaluate('!!document.querySelector("ash-agent-dock textarea")'), false)
    await inZone(`
        const config=JSON.parse(JSON.stringify(qaAISettings.configService.config))
        config.policy.commandRules=[{command:'printf',risk:'DENY'}]
        await qaAISettings.configService.save(config)
        window.localStorage.ashFullAccessAcknowledged='true'
        await ng.getComponent(document.querySelector('ash-agent-dock')).changePermission('full')
        return true
    `)
    await send('审批测试\r')
    await wait('!ng.getComponent(document.querySelector("ash-agent-dock")).runtime.activeRunId && ng.getComponent(document.querySelector("ash-agent-dock")).runtime.state.value === "DONE"', 'legacy full mode rejects configured denied command')
    assert.equal(await evaluate('ng.getComponent(document.querySelector("ash-agent-dock")).runtime.events.value.some(e=>e.type==="approval" && e.data.automatic && e.data.permissionMode==="full" && e.data.risk==="DENY")'), false)
    await inZone('await qaAISettings.configService.save(qaOriginalAIConfig);await ng.getComponent(document.querySelector("ash-agent-dock")).changePermission("");return true')
    console.log('PASS Electron + SSH (' + testShell + '): input privacy, native output, approval, sensitive Dock, original mode')
    console.log('Screenshots and isolated data:', directory)
    fs.writeFileSync(path.join(root, '.build-cache/native-agent-ui-latest.txt'), directory)
    await evaluate('nativeTest.session.destroy(); true')
    await delay(300)
    void evaluate('require("@electron/remote").app.exit(0)')
}
const timeout = setTimeout(() => { console.error('UI test timed out:', directory); socket?.close(); electron?.kill(); model.close(); process.exitCode = 1 }, 240000)
main().catch(error => { console.error(error); console.error('Test data:', directory); process.exitCode = 1 }).finally(() => {
    clearTimeout(timeout); socket?.close(); electron?.kill(); model.close()
})
