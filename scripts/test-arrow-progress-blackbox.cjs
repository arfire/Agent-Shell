/* Real keyboard events and server-side verification. Requires a rebuilt app
 * and the isolated agent-blackbox fixture with ASH_TEST_DISCLOSURE=1. */
const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    const ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const idle = `!!${dock} && !${dock}.querySelector('.stop-button')`
    const records = async () => (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events
    const submit = async text => {
        await ui.click('.xterm-screen')
        await ui.type(text)
        await ui.key('Enter', 'Enter')
    }
    try {
        await ui.wait(`document.body.innerText.includes('Blackbox bash')`, 'fixture ready')
        if (!await ui.read(`!!${dock}`)) await ui.click('.tree-item span', 'Blackbox bash', 'left', 2)
        await ui.wait(`!!${dock} && !${dock}.querySelector('.notice')`, 'terminal ready')
        for (const narrow of [false, true]) {
            if (narrow) await ui.resize(760, 600)
            const value = 'ARROW_' + 'ab'.repeat(30) + '中文ABCD'
            const prefix = `printf '%s' '${value.slice(0, -2)}`
            const before = (await records()).length
            await ui.click('.xterm-screen')
            await ui.type(`printf '%s' '${value}' > /tmp/blackbox-vim.txt`)
            await ui.key('Home', 'Home')
            for (const _ of prefix) await ui.key('ArrowRight', 'ArrowRight')
            await ui.type('X')
            await ui.screenshot(narrow ? 'arrow-edited-narrow' : 'arrow-edited-desktop')
            await ui.key('Enter', 'Enter')
            const expected = value.slice(0, -2) + 'XCD'
            let written = ''
            for (let index = 0; index < 60; index++) {
                try { written = (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/verify`)).json()).file } catch {}
                if (written === expected) break
                await new Promise(resolve => setTimeout(resolve, 100))
            }
            assert.equal(written, expected)
            assert.equal((await records()).length, before, 'Shell edit must not call the model')
            ui.report('PASS: right arrow, Chinese text and server-verified edit at ' + (narrow ? 'narrow width' : 'desktop width'))
        }
        await ui.resize()
        await submit('BB_ROUTINE')
        await ui.wait(idle, 'routine query completes without output approval')
        assert.ok((await records()).filter(e => e.scenario === 'BB_ROUTINE').at(-1)?.tool?.output.includes('Filesystem'))
        ui.report('PASS: routine disk query completes without disclosure prompt')
        await submit('BB_LONG_PROGRESS')
        await ui.wait(`!!${dock}.querySelector('.interaction textarea')`, 'long command approval')
        await ui.click('button', '允许执行')
        if (await ui.locate('button', '确认执行危险命令')) await ui.click('button', '确认执行危险命令')
        await ui.wait(idle, 'download survives 120 seconds', 155000)
        assert.ok((await records()).filter(e => e.scenario === 'BB_LONG_PROGRESS').at(-1)?.tool?.output.includes('DOWNLOAD_COMPLETE'))
        await ui.screenshot('progress-complete-after-130-seconds')
        assert.equal(ui.errors.length, 0)
        ui.report('PASS: 130-second command completes; inspect screenshot for single-row progress')
        console.log('Arrow, automatic diagnostics and long progress black-box checks passed')
    } finally { await ui.resize().catch(() => {}); ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
