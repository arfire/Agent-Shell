/* Synthetic unsupported container -> real settings -> HTTP checks -> save -> restart. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const yaml = require('../tabby-ai/node_modules/js-yaml')
const { connect } = require('./agent-blackbox-driver.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main () {
    let ui = await connect()
    const root = path.resolve(__dirname, '..', '.build-cache') + path.sep
    assert.ok(path.resolve(ui.info.directory).startsWith(root), 'Only isolated fixture data may be changed')
    const key = 'LOCAL_SETTINGS_KEY_873145'
    const requests = []
    const model = http.createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        const request = JSON.parse(body)
        requests.push({ authorized: req.headers.authorization === 'Bearer ' + key, body: request })
        const tool = request.messages.at(-1)?.role === 'tool' ? JSON.parse(request.messages.at(-1).content) : null
        const message = tool ? { content: tool.value } : request.tools?.length
            ? { tool_calls: [{ index: 0, id: 'local_check', type: 'function', function: { name: 'ash_connection_check', arguments: '{"text":"ash-check"}' } }] }
            : { content: 'OK' }
        if (!request.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] })); return }
        res.setHeader('Content-Type', 'text/event-stream')
        res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n')
    })
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    const restart = async () => {
        const info = ui.info
        ui.close()
        await fetch(`http://127.0.0.1:${info.controlPort}/restart`, { method: 'POST' })
        ui = await connect()
        await ui.wait(`!!document.querySelector('button[ng-reflect-ngb-tooltip="Settings"]')`, 'app ready', 30000)
    }
    const scroll = async delta => {
        const size = await ui.read('({width:innerWidth,height:innerHeight})')
        await ui.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: size.width * .65, y: size.height * .6, deltaX: 0, deltaY: delta })
        await delay(250)
    }
    const settings = async () => {
        await ui.click('button[ng-reflect-ngb-tooltip="Settings"]')
        await ui.click('a.nav-link', 'AI')
        await ui.wait(`!!document.querySelector('ash-ai-settings input[type=password]')`, 'AI fields')
        await scroll(-5000)
    }
    const fill = async (selector, value) => { await ui.click(selector); await ui.key('a', 'KeyA', 2); await ui.type(value) }
    const check = async () => {
        await scroll(700)
        for (let i = 0; i < 8 && !await ui.locate('ash-ai-settings button', '检查模型可用性'); i++) await scroll(300)
        await ui.click('ash-ai-settings button', '检查模型可用性')
        await ui.wait(`document.querySelector('ash-ai-settings').innerText.includes('四项检查通过')`, 'four checks passed')
    }
    try {
        const corePath = path.join(ui.info.directory, 'config.yaml')
        const aiPath = path.join(ui.info.directory, 'tabby-ai/config.yaml')
        const core = yaml.load(fs.readFileSync(corePath, 'utf8'))
        const config = yaml.load(fs.readFileSync(aiPath, 'utf8'))
        core.vault = { version: 1, contents: 'UNSUPPORTED_SYNTHETIC_CONTAINER', keySalt: '', iv: '' }
        config.llm.apiKey = 'ash-vault:unavailable-model'
        config.web.model.apiKey = 'ash-vault:unavailable-web'
        config.web.authorization = 'ash-vault:unavailable-search'
        fs.writeFileSync(corePath, yaml.dump(core))
        fs.writeFileSync(aiPath, yaml.dump(config))
        await restart()
        await settings()
        assert.equal(await ui.read(`document.querySelector('ash-ai-settings input[type=password]').value`), '')
        assert.ok(await ui.read(`document.querySelector('ash-ai-settings').innerText.includes('无法读取，请重新填写后保存')`))
        assert.equal(yaml.load(fs.readFileSync(corePath, 'utf8')).vault.version, 1, 'Opening settings does not convert the container')
        await ui.screenshot('credential-settings-reenter')
        await fill('ash-ai-settings .settings-section input[type=text]', `http://127.0.0.1:${model.address().port}/v1`)
        await fill('ash-ai-settings input[type=password]', key)
        await check()
        await scroll(5000)
        await ui.click('ash-ai-settings button', '保存')
        await ui.wait(`document.body.innerText.includes('已保存，后续请求和命令使用新配置')`, 'saved')
        const saved = yaml.load(fs.readFileSync(corePath, 'utf8'))
        assert.equal(saved.vault.version, 2)
        assert.ok(!fs.readFileSync(corePath, 'utf8').includes(key))
        assert.ok(!fs.readFileSync(aiPath, 'utf8').includes(key))
        assert.match(yaml.load(fs.readFileSync(aiPath, 'utf8')).llm.apiKey, /^ash-vault:/)
        assert.equal(await ui.read(`document.querySelectorAll('.modal-dialog').length`), 0)
        await ui.screenshot('credential-settings-saved')
        await restart()
        await settings()
        assert.ok(!await ui.read(`document.querySelector('ash-ai-settings').innerText.includes('无法读取，请重新填写后保存')`))
        await check()
        assert.equal(requests.length, 8)
        assert.ok(requests.every(request => request.authorized))
        assert.ok(!JSON.stringify(requests.map(request => request.body)).includes(key))
        assert.equal(ui.errors.length, 0)
        await ui.screenshot('credential-settings-restarted')
        ui.report('PASS: unsupported container, reenter fields, four compatibility checks, save and authenticated restart; no master prompt')
        console.log('Credential settings blackbox passed: check, save, restart, authentication, no master prompt')
    } catch (error) { await ui.screenshot('credential-settings-failed').catch(() => {}); throw error }
    finally { ui.close(); await new Promise(resolve => model.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
