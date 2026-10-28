/* Electron public input -> real Agent -> synthetic model -> real non-PTY SSH sudo. */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { connect } = require('./agent-blackbox-driver.cjs')
const root = path.resolve(__dirname, '..')
const password = crypto.randomBytes(24).toString('hex') + '\'"$()%\\'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let fixture, info, ui
async function main () {
    fixture = spawn(process.execPath, [path.join(__dirname, 'agent-blackbox-fixture.cjs')], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASH_TEST_APPROVAL_MODE: 'full', ASH_TEST_SUDO_PASSWORD: password, ASH_TEST_DISCLOSURE: '1' },
    })
    let output = ''
    fixture.stdout.on('data', chunk => {
        output += chunk
        for (const line of output.split('\n')) {
            try { const parsed = JSON.parse(line); if (parsed.directory && parsed.controlPort) info = parsed } catch {}
        }
    })
    fixture.stderr.on('data', chunk => process.stderr.write(chunk))
    for (let attempt = 0; attempt < 300 && !info; attempt++) {
        if (fixture.exitCode !== null) throw new Error('Fixture exited')
        await delay(200)
    }
    assert.ok(info, 'fixture ready')
    ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    await ui.wait('document.body?.innerText.includes("Blackbox bash")', 'app ready')
    if (!await ui.read(`!!${dock}`)) await ui.click('.tree-item span', 'Blackbox bash', 'left', 2)
    await ui.wait(`!!${dock} && !${dock}.querySelector('.notice')`, 'SSH ready')
    await ui.click('.xterm-screen'); await ui.type('BB_SUDO 部署 Gitea 的测试配置'); await ui.key('Enter', 'Enter')
    await ui.wait(`!!${dock}.querySelector('input[type=password]')`, 'sudo password form')
    await ui.click('.interaction input[type=password]'); await ui.type(password)
    await ui.click('.interaction .actions button', '继续')
    let events
    for (let attempt = 0; attempt < 200; attempt++) {
        events = (await (await fetch(`http://127.0.0.1:${info.controlPort}/state`)).json()).events.filter(event => event.scenario === 'BB_SUDO')
        if (events.length >= 5) break
        await delay(100)
    }
    assert.equal(events.length, 5, 'one form and three successful deployment operations')
    assert.match(events[1].tool.value, /^__TABBY_SENSITIVE_\d+__$/)
    for (const event of events.slice(2)) assert.equal(event.tool.exitCode, 0, JSON.stringify(event.tool))
    assert.ok(!JSON.stringify(events).includes(password), 'password never reaches model messages')
    await ui.wait(`!!${dock} && !${dock}.querySelector('.stop-button')`, 'deployment completed')
    assert.equal(ui.errors.length, 0)
    const checked = spawnSync(process.env.ASH_TEST_DOCKER || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        ['exec', info.name, 'sh', '-c', 'test -d /opt/ash-gitea-ui/data && test -s /opt/ash-gitea-ui/docker-compose.yml && test -s /opt/ash-gitea-ui/compose.python.yml'],
        { cwd: root, windowsHide: true, encoding: 'utf8' })
    assert.equal(checked.status, 0, 'real server deployment files exist')
    for (const filename of fs.readdirSync(path.join(info.directory, 'tabby-ai')).filter(file => file.endsWith('.jsonl'))) {
        assert.ok(!fs.readFileSync(path.join(info.directory, 'tabby-ai', filename), 'utf8').includes(password))
    }
    await ui.screenshot('sudo-deployment-success')
    ui.report('PASS: real password form, same-call sudo, heredoc and Python configuration writes, no retries and no password disclosure')
    await ui.click('.xterm-screen'); await ui.type('BB_CONFIG 部署 /tmp/ash-config-project 并更新配置'); await ui.key('Enter', 'Enter')
    await ui.wait(`!!${dock}.querySelector('input[type=password]')`, 'configuration password form')
    await ui.click('.interaction input[type=password]'); await ui.type(password)
    await ui.click('.interaction .actions button', '继续')
    let configurationEvents
    for (let attempt = 0; attempt < 300; attempt++) {
        configurationEvents = (await (await fetch(`http://127.0.0.1:${info.controlPort}/state`)).json()).events.filter(event => event.scenario === 'BB_CONFIG')
        if (configurationEvents.length >= 6) break
        await delay(100)
    }
    assert.equal(configurationEvents.length, 6, JSON.stringify(configurationEvents.map(event => event.tool)))
    assert.ok(configurationEvents[1].tool.fields && configurationEvents[2].tool.written && configurationEvents[4].tool.written)
    assert.ok(configurationEvents[1].tool.fields.some(field => field.path.at(-1) === 'GITEA__server__ROOT_URL' && field.value === 'http://192.168.1.190:3000/'))
    assert.equal(configurationEvents[5].tool.exitCode, 0, JSON.stringify(configurationEvents[5].tool))
    const recorded = JSON.stringify(configurationEvents)
    for (const secret of [password, 'CONFIG_OLD_SECRET_CANARY', 'CONFIG_UNKNOWN_CANARY', 'CONFIG_COMMENT_CANARY']) {
        assert.ok(!recorded.includes(secret), 'private value reached model')
    }
    await ui.wait(`!!${dock} && !${dock}.querySelector('.stop-button')`, 'configuration completed')
    const config = spawnSync(process.env.ASH_TEST_DOCKER || 'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
        ['exec', info.name, 'cat', '/tmp/ash-config-project/compose.yml'], { cwd: root, windowsHide: true, encoding: 'utf8' })
    assert.equal(config.status, 0)
    const document = require('../tabby-ai/node_modules/yaml').parse(config.stdout)
    assert.equal(document.services.gitea.environment.DB_PASSWORD, 'CONFIG_OLD_SECRET_CANARY')
    assert.equal(document.services.gitea.environment.UNKNOWN, 'CONFIG_UNKNOWN_CANARY')
    assert.equal(document.services.gitea.environment.NEW_PASSWORD, password.replace(/\$/g, () => '$$'))
    assert.deepEqual(document.services.gitea.ports, ['3001:3000'])
    assert.equal(document.services.gitea.environment.GITEA__server__ROOT_URL, 'http://192.168.1.190:3001/')
    assert.ok(config.stdout.includes('# CONFIG_COMMENT_CANARY'))
    const configPath = path.join(info.directory, 'verified-compose.yml')
    fs.writeFileSync(configPath, config.stdout)
    const validated = spawnSync(process.env.ASH_TEST_DOCKER || 'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
        ['compose', '-f', configPath, 'config', '--quiet'], { cwd: root, windowsHide: true, encoding: 'utf8' })
    assert.equal(validated.status, 0, validated.stderr)
    await ui.screenshot('configuration-deployment-success')
    ui.report('PASS: structured YAML read/write, preserved secret and comment, field-bound password, normal archives/variables/scripts and Compose validation')
    console.log('PASS Electron deployment and configuration flow:', info.directory)
}
main().catch(async error => {
    await ui?.screenshot('sudo-deployment-failure').catch(() => {})
    console.error(error); process.exitCode = 1
}).finally(async () => {
    ui?.close()
    if (info) await fetch(`http://127.0.0.1:${info.controlPort}/stop`, { method: 'POST' }).catch(() => {})
    else fixture?.kill()
})
