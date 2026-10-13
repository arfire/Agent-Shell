/* Real UI input and disposable SSH: exercise output while switching prompt ownership. */
const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main () {
    const ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const modelEvents = async () => (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events
    try {
        await ui.wait(`document.body?.innerText.includes('Blackbox bash')`, 'ready')
        for (const shell of ['bash', 'zsh', 'fish']) {
            const profile = 'Blackbox ' + shell
            await ui.wait(`[...document.querySelectorAll('.tree-item span, .cdk-drag.name')].some(e=>{const r=e.getBoundingClientRect();return e.textContent.trim()===${JSON.stringify(profile)}&&r.width>0&&r.height>0&&r.x>=0&&r.right<innerWidth&&r.bottom<innerHeight})`, shell + ' visible profile')
            // Open the current profile, rather than a restored tab containing
            // the previous transport settings from before the test restart.
            await ui.click('.tree-item span', profile, 'left', 2)
            await ui.wait(`!!${dock} && !${dock}.querySelector('.notice')`, shell + ' ready')
            for (const mode of ['Shell 模式', 'Agent 模式']) {
                if (await ui.read(`${dock}.querySelector('.mode-button').innerText.trim()`) !== mode) await ui.click('.mode-button')
                await ui.click('.xterm-screen')
                await ui.type('printf "\\033[2J\\033[H"')
                await ui.key('Enter', 'Enter')
                await delay(200)
                const before = (await modelEvents()).length
                for (let i = 0; i < 24; i++) {
                    await ui.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
                    await ui.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
                    await delay(i % 3 === 0 ? 45 : 5)
                }
                await delay(300)
                await ui.screenshot(`stream-${shell}-${mode.startsWith('Shell') ? 'shell' : 'agent'}-enter`)
                // Fresh input and output must still work after the burst.
                const marker = 'STREAM_' + shell + '_' + Date.now()
                await ui.type(`printf '${marker}\\n' | tee -a /tmp/blackbox-vim.txt; chmod 666 /tmp/blackbox-vim.txt`)
                await ui.key('Enter', 'Enter')
                let found = false
                for (let i = 0; i < 60; i++) {
                    const result = await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/verify`)).json()
                    if (result.file.includes(marker)) { assert.equal(result.file.split(marker).length - 1, 1); found = true; break }
                    await delay(100)
                }
                assert.ok(found, shell + ' input stalled')
                assert.equal((await modelEvents()).length, before, 'Shell input must not invoke the model')
                ui.report(`PASS: ${shell}, ${mode}, 24 rapid Enter events then exactly one successful command`)
            }
        }
        assert.equal(ui.errors.length, 0)
        console.log('6 SSH UI stream scenarios passed: bash/zsh/fish, Shell/Agent modes')
    } catch (error) {
        await ui.screenshot('stream-failure').catch(() => {})
        throw error
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
