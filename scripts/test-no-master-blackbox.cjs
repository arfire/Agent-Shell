/* Real UI, persisted portable data and HTTP authentication, across app restart. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('../tabby-ai/node_modules/js-yaml')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    let ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const events = async () => (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events
    const open = async () => {
        await ui.wait(`document.body?.innerText.includes('Blackbox bash')`, 'app ready')
        await ui.wait(`!!${dock} || [...document.querySelectorAll('.tree-item span')].some(e=>{const r=e.getBoundingClientRect();return e.textContent.trim()==='Blackbox bash'&&r.width>0&&r.height>0&&r.x>=0&&r.right<innerWidth&&r.bottom<innerHeight})`, 'visible terminal or profile')
        if (!await ui.read(`!!${dock}`)) await ui.click('.tree-item span', 'Blackbox bash', 'left', 2)
        await ui.wait(`!!${dock} && !${dock}.querySelector('.notice')`, 'SSH ready')
    }
    const request = async count => {
        await ui.click('.xterm-screen'); await ui.type('BB_UNAME'); await ui.key('Enter', 'Enter')
        for (let i = 0; i < 150 && (await events()).length < count + 2; i++) await new Promise(resolve => setTimeout(resolve, 100))
        const sent = (await events()).slice(count)
        assert.equal(sent.length, 2, 'Model round-trip completed without another password prompt')
        assert.ok(sent.every(e => e.authorized), 'Saved API key used in HTTP Authorization')
        assert.match(sent.at(-1).tool.output, /Linux/)
        await ui.wait(`!!${dock} && !${dock}.querySelector('.stop-button')`, 'request complete')
        assert.equal(await ui.read(`document.querySelectorAll('.modal-dialog').length`), 0)
        assert.ok(!JSON.stringify(sent.map(e => e.request)).includes('LOCAL_BLACKBOX_MODEL_KEY_791364'))
    }
    try {
        await open(); await request(0)
        const disk = yaml.load(fs.readFileSync(path.join(ui.info.directory, 'config.yaml'), 'utf8'))
        assert.equal(disk.vault.version, 2)
        assert.match(disk.vault.localKey, /^[a-f0-9]{64}$/)
        await ui.screenshot('no-master-before-restart')
        const info = ui.info
        ui.close()
        await fetch(`http://127.0.0.1:${info.controlPort}/restart`, { method: 'POST' })
        ui = await connect()
        await open(); await request(2)
        await ui.screenshot('no-master-after-restart')
        assert.equal(ui.errors.length, 0)
        ui.report('PASS: new automatic credential storage' + ', actual API authentication, restart without master password')
        console.log('No-master-password UI and restart checks passed')
    } catch (error) {
        await ui.screenshot('no-master-failure').catch(() => {})
        ui.report('FAIL: no-master-password', String(error)); throw error
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
