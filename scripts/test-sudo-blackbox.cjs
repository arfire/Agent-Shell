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
    console.log('PASS Electron sudo deployment flow:', info.directory)
}
main().catch(async error => {
    await ui?.screenshot('sudo-deployment-failure').catch(() => {})
    console.error(error); process.exitCode = 1
}).finally(async () => {
    ui?.close()
    if (info) await fetch(`http://127.0.0.1:${info.controlPort}/stop`, { method: 'POST' }).catch(() => {})
    else fixture?.kill()
})
