/* Actual terminal input, disposable SSH servers and an independent model recorder. */
const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    const ui = await connect()
    const active = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const idle = `!!${active} && !${active}.querySelector('.stop-button')`
    const events = async () => (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events
    const waitFile = async (marker, count) => {
        for (let i = 0; i < 60; i++) {
            const result = await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/verify`)).json()
            if (result.file.split(marker).length - 1 >= count) return
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Shell output was not written: ' + marker)
    }
    const enter = async text => {
        await ui.click('.xterm-screen')
        await ui.type(text)
        await ui.key('Enter', 'Enter')
    }
    try {
        for (const shell of ['bash', 'zsh', 'fish']) {
            const profile = 'Blackbox ' + shell
            await ui.wait(`[...document.querySelectorAll('.tree-item span')].some(e=>{const r=e.getBoundingClientRect();return e.textContent.trim()===${JSON.stringify(profile)}&&r.width>0&&r.x>=0&&r.bottom<innerHeight})`, shell + ' visible profile')
            await ui.click('.tree-item span', profile, 'left', 2)
            await ui.wait(`${active}?.querySelector('.mode-button')?.innerText.trim()==='Agent 模式' && !${active}?.querySelector('.notice')`, shell + ' integration ready')
            assert.equal(await ui.read(`document.querySelectorAll('.agent-composer').length`), 0)
            const before = (await events()).length
            const marker = 'INLINE_SHELL_' + shell.toUpperCase() + '_' + Date.now()
            // The three disposable SSH users share this verification file.
            const shareFile = shell === 'bash' ? '; chmod 666 /tmp/blackbox-vim.txt' : ''
            await enter(`printf '${marker}\\n' | tee -a /tmp/blackbox-vim.txt${shareFile}`)
            await waitFile(marker, 1)
            assert.equal((await events()).length, before, 'Shell command must not request the model')
            // Native readline history remains owned by the remote shell until its prompt returns.
            await ui.key('ArrowUp', 'ArrowUp')
            await ui.key('Enter', 'Enter')
            await waitFile(marker, 2)
            assert.equal((await events()).length, before)
            const request = `请用中文简单回答，验证${shell}自动识别 ${Date.now()}`
            await enter(request)
            for (let i = 0; i < 60 && (await events()).length === before; i++) await new Promise(resolve => setTimeout(resolve, 100))
            await ui.wait(idle, shell + ' natural language completes')
            const sent = (await events()).slice(before)
            assert.equal(sent.length, 1, 'Natural language must route exactly once')
            assert.equal(sent[0].request.messages.at(-1).content, request)
            assert.equal(JSON.stringify(sent[0].request).includes(marker), false, 'Unreviewed manual output stays local')
            ui.report('PASS: ' + shell + ' direct Shell, native history, automatic Chinese routing and local-only terminal history')
        }
        assert.equal(ui.errors.length, 0)
        await ui.screenshot('inline-input-restored')
        console.log('3 shell end-to-end routing scenarios passed: bash, zsh, fish.')
    } catch (error) {
        await ui.screenshot('inline-input-failure').catch(() => {})
        ui.report('FAIL: inline input', String(error))
        throw error
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
