/* Real terminal keyboard input and visible SFTP listings; no app-service calls. */
const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    const ui = await connect()
    const active = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const breadcrumb = `[...document.querySelectorAll('workspace-files .breadcrumb a')].map(e=>e.innerText.trim()).slice(1).join('/')`
    const directory = (value, label) => ui.wait(`(${breadcrumb})===${JSON.stringify(value.replace(/^\//, ''))} && !document.querySelector('workspace-files [role=status]')`, label)
    const enter = async text => { await ui.click('.xterm-screen'); await ui.type(text); await ui.key('Enter', 'Enter') }
    try {
        for (const shell of ['bash', 'zsh', 'fish']) {
            const profile = 'Blackbox ' + shell
            if (await ui.read(`[...document.querySelectorAll('.cdk-drag.name')].some(e=>e.innerText.trim()===${JSON.stringify(profile)})`)) {
                await ui.click('.cdk-drag.name', profile)
            } else {
                await ui.click('button', '服务器')
                await ui.click('.tree-item span', profile, 'left', 2)
            }
            await ui.wait(`!!${active}?.querySelector('.mode-button')`, 'SSH tab ready')
            // Start a repeat run from either input mode.
            if (await ui.read(`${active}.querySelector('.mode-button').innerText.trim()==='Shell 模式'`)) {
                await ui.click('.mode-button', 'Shell 模式')
                await ui.key('Enter', 'Enter')
            }
            await ui.wait(`!${active}?.querySelector('.notice')`, shell + ' prompt ready')
            await ui.click('button', '文件')
            await ui.wait(`!!document.querySelector('workspace-files input[type=checkbox]')`, 'file panel ready')
            if (!await ui.read(`document.querySelector('workspace-files input[type=checkbox]').checked`)) {
                await ui.click('workspace-files input[type=checkbox]')
            }
            await enter('cd /tmp')
            await directory('/tmp', shell + ' Agent-mode follow')
            await ui.click('.mode-button', 'Agent 模式')
            await enter('cd /etc')
            await directory('/etc', shell + ' Shell-mode follow')
            await ui.wait(`document.querySelector('workspace-files').innerText.includes('passwd')`, shell + ' real directory contents')
            await ui.click('.mode-button', 'Shell 模式')
            await ui.wait(`!${active}?.querySelector('.notice')`, shell + ' automatic input restored')
            const path = '/tmp/ash-sftp 中文 ' + shell
            await enter(`mkdir -p '${path}' && cd '${path}'`)
            await directory(path, shell + ' Unicode and spaces')
            await ui.click('workspace-files input[type=checkbox]')
            await enter('cd /tmp')
            await ui.wait(`!document.querySelector('workspace-files button').disabled`, 'terminal directory available')
            // Polling cadence is 500 ms: allow two periods before asserting follow-off.
            await new Promise(resolve => setTimeout(resolve, 1100))
            assert.equal(await ui.read(breadcrumb), path.slice(1))
            await ui.click('button', '跳转到终端目录')
            await directory('/tmp', shell + ' manual jump')
            await ui.click('workspace-files input[type=checkbox]')
            ui.report('PASS: SFTP follows ' + shell + ' in Agent/Shell modes, Unicode paths, manual jump and follow-off')
        }
        await ui.click('button', 'Reconnect')
        await directory('/home/ashfish', 'SFTP follows reconnected shell home')
        await ui.wait(`!${active}?.querySelector('.notice')`, 'reconnected prompt ready')
        await enter('cd /etc')
        await directory('/etc', 'SFTP follows after reconnect')
        ui.report('PASS: SFTP recreates its connection and follows the new shell after reconnect')
        assert.equal(ui.errors.length, 0)
        await ui.screenshot('sftp-follow-fixed')
        console.log('4 SFTP black-box scenarios passed: bash, zsh, fish, reconnect.')
    } catch (error) {
        ui.report('FAIL: SFTP follow', String(error))
        throw error
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
