const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    const ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const idle = `!!${dock} && !${dock}.querySelector('.stop-button')`
    try {
        for (const scenario of ['BB_STOP', 'BB_PROGRESS_STOP']) {
            await ui.click('.xterm-screen')
            await ui.type(scenario)
            await ui.key('Enter', 'Enter')
            await ui.wait(`!!${dock}.querySelector('.interaction textarea')`, 'stop command approval')
            await ui.click('button', '允许执行')
            if (await ui.locate('button', '确认执行危险命令')) await ui.click('button', '确认执行危险命令')
            await ui.wait(`${dock}.innerText.includes('执行中')`, 'long command started')
            await new Promise(resolve => setTimeout(resolve, 2200))
            await ui.screenshot('before-stop-' + scenario)
            await ui.click('button', '停止 Agent')
            await ui.wait(idle, 'stop releases terminal within 5 seconds', 5000)
            await ui.screenshot('after-stop-' + scenario)
            const marker = 'AFTER_STOP_' + Date.now()
            await ui.click('.xterm-screen')
            await ui.type(`printf '%s' '${marker}' > /tmp/blackbox-vim.txt`)
            await ui.key('Enter', 'Enter')
            let written = ''
            for (let i = 0; i < 60; i++) {
                try { written = (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/verify`)).json()).file } catch {}
                if (written === marker) break
                await new Promise(resolve => setTimeout(resolve, 100))
            }
            assert.equal(written, marker, 'Terminal must execute a real Shell command after stop')
            ui.report('PASS: ' + scenario + ' stop restores a usable terminal; output retained for visual check')
        }
        assert.equal(ui.errors.length, 0)
        console.log('Silent/progress task stop black-box checks passed')
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
