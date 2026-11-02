/* Node 22: isolated Electron settings smoke test, no SSH or paid model required. */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const WebSocket = require('../node_modules/ws')
const yaml = require('../tabby-ai/node_modules/js-yaml')
const root = path.resolve(__dirname, '..')
const directory = path.join(root, '.build-cache', 'web-ui-' + Date.now())
fs.mkdirSync(path.join(directory, 'tabby-ai'), { recursive: true })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const requests = []
let mode = 'good'
const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization })
    if (req.url.startsWith('/search')) {
        if (new URL(req.url, 'http://localhost').searchParams.get('language') === 'auto') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid value "auto" for parameter language' }))
            return
        }
        if (mode === 'slow') return
        if (mode === '403') { res.writeHead(403); res.end(); return }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ results: [{ title: 'SearXNG documentation', url: 'https://docs.searxng.org/', content: 'JSON search API documentation' }] }))
        return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    if (!request.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
        return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let delta = { content: 'OK' }
    if (request.tools?.length) {
        delta = request.messages.at(-1).role === 'tool'
            ? { content: JSON.parse(request.messages.at(-1).content).value }
            : { tool_calls: [{ index: 0, id: 'check', type: 'function', function: { name: 'ash_connection_check', arguments: '{"text":"ash-check"}' } }] }
    }
    res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n')
})
let electron
let socket
async function main () {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseURL = 'http://127.0.0.1:' + server.address().port
    const config = yaml.load(fs.readFileSync(path.join(root, 'tabby-ai/default-config.yaml'), 'utf8'))
    // Exercise migration from a config that predates web support.
    delete config.web
    config.llm = { ...config.llm, baseURL: baseURL + '/v1', model: 'main-test' }
    fs.writeFileSync(path.join(directory, 'tabby-ai/config.yaml'), yaml.dump(config))
    fs.writeFileSync(path.join(directory, 'config.yaml'), yaml.dump({ version: 7, enableAnalytics: false, appearance: { colorScheme: 'dark' }, recovery: [] }))
    const portServer = http.createServer()
    await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
    const port = portServer.address().port
    await new Promise(resolve => portServer.close(resolve))
    const bootstrap = path.join(directory, 'bootstrap.cjs')
    fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.join(root, 'app'))});app.requestSingleInstanceLock=()=>true;app.setAsDefaultProtocolClient=()=>false;require(${JSON.stringify(path.join(root, 'app/dist/main.js'))});`)
    const log = fs.openSync(path.join(directory, 'electron.log'), 'w')
    electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, '--remote-debugging-port=' + port], {
        cwd: root, windowsHide: true, stdio: ['ignore', log, log],
        env: { ...process.env, TABBY_DEV: '1', TABBY_DATA_DIRECTORY: directory, TABBY_CONFIG_DIRECTORY: directory },
    })
    electron.on('error', error => console.error(error))
    let target
    for (let tries = 0; tries < 150; tries++) {
        try { target = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(item => item.type === 'page'); if (target) break } catch {}
        await delay(200)
    }
    if (!target) throw new Error('Electron did not start: ' + directory)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise(resolve => socket.once('open', resolve))
    let id = 0
    const waiting = new Map()
    socket.on('message', data => {
        const message = JSON.parse(data)
        if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
    })
    const call = async (method, params = {}) => {
        const current = ++id
        const response = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { waiting.delete(current); reject(new Error('CDP timeout: ' + method)) }, 15000)
            waiting.set(current, message => { clearTimeout(timeout); resolve(message) })
        })
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
    const wait = async expression => {
        for (let tries = 0; tries < 150; tries++) {
            if (await evaluate(expression)) return
            await delay(100)
        }
        throw new Error('UI timeout: ' + expression + '\n' + await evaluate('document.body.innerText.slice(-2000)'))
    }
    const inZone = code => evaluate(`ng.getInjector(document.querySelector('app-root')).get(require('@angular/core').NgZone).run(async () => { ${code} })`)
    const screen = async name => {
        await delay(150)
        fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    }
    await wait('!!window.ng?.getComponent?.(document.querySelector("app-root"))?.ready')
    await inZone(`const app=ng.getComponent(document.querySelector('app-root')).app;app.openNewTab({type:require('tabby-settings').SettingsTabComponent,inputs:{activeTab:'ai'}});return true`)
    await wait('!!document.querySelector("ash-ai-settings") && !!ng.getComponent(document.querySelector("ash-ai-settings"))?.model')
    await inZone(`window.qa=ng.getComponent(document.querySelector('ash-ai-settings'));qa.section='web';return true`)
    await wait(`!!document.querySelector('input[aria-label="SearXNG 服务地址"]')`)
    assert.equal(await evaluate('qa.web.useDefaultModel'), true)
    assert.equal(await evaluate(`!!document.querySelector('input[aria-label="联网模型名称"]')`), false)
    assert.equal(await evaluate('qa.web.mode'), 'off')
    await inZone(`qa.web.baseURL=${JSON.stringify(baseURL)};qa.web.mode='auto';qa.web.authorization='Bearer ui-search-secret';return true`)
    await inZone('await qa.testWeb();return true')
    assert.equal(await evaluate('qa.webResult.success'), true)
    await screen('web-default-model')
    await evaluate('document.querySelector("ash-ai-settings .settings-section input[type=checkbox]").click();true')
    await wait(`!!document.querySelector('input[aria-label="联网模型名称"]')`)
    assert.equal(await evaluate('qa.web.useDefaultModel'), false)
    await inZone(`qa.web.model={baseURL:${JSON.stringify(baseURL + '/v1')},apiKey:'ui-model-secret',model:'research-test',temperature:0.2,timeout:1000};await qa.testWeb(true);return true`)
    assert.equal(await evaluate('qa.webResult.success'), true)
    await inZone('await qa.save();return true')
    let saved = yaml.load(fs.readFileSync(path.join(directory, 'tabby-ai/config.yaml'), 'utf8'))
    assert.equal(saved.web.useDefaultModel, false)
    assert.equal(saved.web.model.model, 'research-test')
    assert.equal(saved.llm.model, 'main-test')
    await evaluate(`document.querySelector('input[aria-label="联网模型名称"]').scrollIntoView({block:'center'});true`)
    await screen('web-custom-model')
    await evaluate('document.querySelector("ash-ai-settings .settings-section input[type=checkbox]").click();true')
    await wait(`!document.querySelector('input[aria-label="联网模型名称"]')`)
    await inZone('await qa.save();return true')
    saved = yaml.load(fs.readFileSync(path.join(directory, 'tabby-ai/config.yaml'), 'utf8'))
    assert.equal(saved.web.useDefaultModel, true)
    assert.equal(saved.web.model.model, 'research-test', 'toggling preserves custom configuration')
    mode = '403'
    await inZone('await qa.testWeb();return true')
    assert.equal(await evaluate('qa.webResult.success'), false)
    assert.match(await evaluate('qa.webResult.message'), /403/)
    mode = 'slow'
    await inZone('void qa.testWeb();return true')
    await wait('qa.webTesting')
    await inZone('qa.cancelWebCheck();return true')
    await wait('!qa.webTesting')
    assert.match(await evaluate('qa.webResult.message'), /取消/)
    mode = 'good'
    await inZone('qa.markWebChanged();return true')
    await screen('web-final')
    assert.ok(requests.filter(item => item.url.startsWith('/search')).every(item => item.auth === 'Bearer ui-search-secret'))
    console.log('PASS web settings migration, checkbox visibility, custom model check, persistence, 403 and cancellation')

    const policyKeys = ['autoApprove', 'requireApproval', 'requireSecondApproval', 'deny']
    const fill = async (selector, value) => inZone(`const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return true`)
    await inZone(`qa.section='policy';return true`)
    await wait(`!!document.querySelector('#ai-policy-deny')`)
    for (const key of policyKeys) {
        assert.equal(await evaluate(`document.querySelector('#ai-policy-${key}').value`), config.policy[key].join('\n'), key + ' loads saved rules')
    }
    await evaluate(`document.querySelector('#ai-policy-autoApprove').scrollIntoView({block:'center'});true`)
    await screen('policy-rules-loaded')
    const keyboardPattern = '^\\s*id$'
    await evaluate(`const input=document.querySelector('#ai-policy-autoApprove');input.focus();input.setSelectionRange(input.value.length,input.value.length);true`)
    await call('Input.insertText', { text: '\n' })
    await call('Input.insertText', { text: keyboardPattern })
    assert.deepEqual(await evaluate('qa.model.policy.autoApprove'), [...config.policy.autoApprove, keyboardPattern], 'typing a newline then a rule creates a separate pattern')
    assert.ok((await evaluate(`document.querySelector('#ai-policy-autoApprove').value`)).endsWith('\n' + keyboardPattern), 'the textarea preserves the inserted line break while typing')
    const edited = {
        autoApprove: ['^\\s*whoami$', '  ^literal\\s+spaces$  '],
        requireApproval: ['^\\s*pwd$'],
        requireSecondApproval: ['^\\s*hostname$'],
        deny: ['^\\s*date$'],
    }
    for (const key of policyKeys) {
        await fill('#ai-policy-' + key, '\n' + edited[key].join('\n\n') + '\n  \n')
        assert.deepEqual(await evaluate(`qa.model.policy.${key}`), edited[key], key + ' filters blank lines and preserves expressions')
    }
    await fill('#ai-policy-deny', '  \n\t\n')
    assert.deepEqual(await evaluate('qa.model.policy.deny'), [], 'an empty editor clears only its rule group')
    await fill('#ai-policy-deny', edited.deny.join('\n'))
    await inZone(`qa.section='model';return true`)
    await wait(`!document.querySelector('#ai-policy-deny')`)
    await inZone(`qa.section='policy';return true`)
    await wait(`!!document.querySelector('#ai-policy-deny')`)
    for (const key of policyKeys) {
        assert.equal(await evaluate(`document.querySelector('#ai-policy-${key}').value`), edited[key].join('\n'), key + ' survives changing settings pages')
    }
    for (const [command, result] of [['whoami', '自动执行'], ['pwd', '需要审批'], ['hostname', '二次确认'], ['date', '拦截']]) {
        await fill('#ai-command-preview', command)
        await inZone('qa.preview();return true')
        assert.ok((await evaluate('qa.previewResult')).includes('若由 Agent 执行：' + result), 'preview uses unsaved rules for ' + command)
    }
    await inZone('await qa.save();return true')
    const policyPath = path.join(directory, 'tabby-ai/config.yaml')
    saved = yaml.load(fs.readFileSync(policyPath, 'utf8'))
    for (const key of policyKeys) assert.deepEqual(saved.policy[key], edited[key], key + ' persists to YAML')
    await call('Page.reload')
    await delay(500)
    await wait('!!window.ng?.getComponent?.(document.querySelector("app-root"))?.ready')
    await inZone(`const app=ng.getComponent(document.querySelector('app-root')).app;app.openNewTab({type:require('tabby-settings').SettingsTabComponent,inputs:{activeTab:'ai'}});return true`)
    await wait('!!document.querySelector("ash-ai-settings") && !!ng.getComponent(document.querySelector("ash-ai-settings"))?.model')
    await inZone(`window.qa=ng.getComponent(document.querySelector('ash-ai-settings'));qa.section='policy';return true`)
    await wait(`!!document.querySelector('#ai-policy-deny')`)
    for (const key of policyKeys) {
        assert.equal(await evaluate(`document.querySelector('#ai-policy-${key}').value`), edited[key].join('\n'), key + ' reloads after renderer restart')
    }
    const validPolicyFile = fs.readFileSync(policyPath, 'utf8')
    await fill('#ai-policy-requireSecondApproval', '[')
    await inZone('await qa.save();return true')
    assert.equal(fs.readFileSync(policyPath, 'utf8'), validPolicyFile, 'invalid regular expression cannot overwrite the saved configuration')
    assert.ok(await evaluate(`document.body.innerText.includes('policy.requireSecondApproval contains an invalid regular expression')`), 'invalid expression identifies its rule group')
    await inZone('await qa.restoreDefaults();return true')
    for (const key of policyKeys) {
        assert.equal(await evaluate(`document.querySelector('#ai-policy-${key}').value`), config.policy[key].join('\n'), key + ' restores the current page defaults')
    }
    assert.equal(fs.readFileSync(policyPath, 'utf8'), validPolicyFile, 'restoring defaults waits for Save')
    await inZone('await qa.save();return true')
    saved = yaml.load(fs.readFileSync(policyPath, 'utf8'))
    for (const key of policyKeys) assert.deepEqual(saved.policy[key], config.policy[key], key + ' saves restored defaults')
    assert.equal(saved.llm.model, 'main-test', 'restoring policy defaults preserves model settings')
    assert.equal(saved.web.model.model, 'research-test', 'restoring policy defaults preserves web settings')
    await evaluate(`document.querySelector('#ai-policy-deny').scrollIntoView({block:'center'});true`)
    await screen('policy-rules-bottom')
    console.log('PASS policy rule editors, blank lines, page switching, unsaved preview, persistence, reload, invalid expression rejection and default restoration')
    console.log('Screenshots: ' + directory)
    await evaluate(`setTimeout(()=>require('@electron/remote').app.exit(0),100);true`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
    socket?.close()
    electron?.kill()
    server.closeAllConnections()
    server.close()
})
