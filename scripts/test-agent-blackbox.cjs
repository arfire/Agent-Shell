/* Start agent-blackbox-fixture.cjs first. Inputs use Chromium's real input
 * pipeline; DOM reads locate controls and assert visible results only. */
const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')

async function main () {
    const ui = await connect()
    const active = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().x>=0)`
    const transcript = `${active}?.querySelector('.agent-transcript')?.innerText || ''`
    const idle = `!!${active} && !${active}.querySelector('.stop-button')`
    const submit = async scenario => {
        await ui.wait(idle, 'idle before ' + scenario)
        await ui.click('.agent-composer textarea')
        await ui.key('a', 'KeyA', 2)
        await ui.type(scenario)
        await ui.click('button', '发送')
    }
    const approve = async () => {
        await ui.wait(`!!${active}?.querySelector('.interaction textarea')`, 'approval appears')
        await ui.click('button', '允许执行')
    }
    const result = async scenario => {
        await ui.wait(`(${transcript}).includes('${scenario} RESULT') && (${idle})`, scenario + ' completes')
        return (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events
            .filter(event => event.scenario === scenario && event.tool).at(-1).tool
    }
    try {
        await ui.wait(`document.body?.innerText.includes('Blackbox bash')`, 'fixture ready')
        if (!await ui.read(`!!${active}`)) {
            const tab = await ui.read(`[...document.querySelectorAll('.cdk-drag.name')].find(e=>e.innerText.includes('Blackbox bash'))?.innerText`)
            if (tab) await ui.click('.cdk-drag.name', tab.trim())
            else await ui.click('.tree-item span', 'Blackbox bash', 'left', 2)
        }
        await ui.wait(`!!${active}?.querySelector('.agent-composer textarea')`, 'connected composer')
        await submit('BB_STATUS')
        await approve()
        const status = await result('BB_STATUS')
        assert.equal(status.exitCode, 0)
        assert.match(status.output, /NO_PTY\nPAGER=cat SYSTEMD_PAGER=cat/)
        ui.report('PASS: no PTY, pager disabled, stdin EOF')

        await submit('BB_EXIT')
        await approve()
        const exited = await result('BB_EXIT')
        assert.equal(exited.exitCode, 1)
        assert.match(exited.output, /BB_STDOUT\n/)
        assert.match(exited.output, /BB_STDERR\n/)
        ui.report('PASS: stdout, stderr and nonzero exit')

        await submit('BB_REJECT')
        await ui.wait(`!!${active}.querySelector('.interaction textarea')`, 'rejection approval')
        await ui.click('button', '拒绝')
        assert.equal((await result('BB_REJECT')).executed, false)
        ui.report('PASS: rejected command not executed')

        await submit('BB_WRITE')
        await ui.wait(`!!${active}.querySelector('.interaction textarea')`, 'editable approval')
        await ui.click('.interaction textarea')
        await ui.key('a', 'KeyA', 2)
        await ui.type("printf 'BB_EDITED_ONLY\\n'")
        await ui.click('button', '允许执行')
        assert.equal((await result('BB_WRITE')).output, 'BB_EDITED_ONLY\n')
        ui.report('PASS: only edited command executes')

        for (const [scenario, error] of [['BB_HTTP_ERROR', 'AI request failed (503)'], ['BB_BROKEN_STREAM', '模型回答意外中断']]) {
            await submit(scenario)
            await ui.wait(`(${transcript}).includes(${JSON.stringify(error)}) && (${idle})`, scenario)
            ui.report('PASS: ' + scenario + ' releases request')
        }
        await submit('BB_STOP')
        await approve()
        await ui.wait(`${active}.innerText.includes('执行中')`, 'sleep starts')
        await ui.click('button', '停止 Agent')
        await ui.wait(idle, 'stop completes')
        ui.report('PASS: stop releases request')

        await ui.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 600, deviceScaleFactor: 1, mobile: false })
        await submit('BB_OUTPUT')
        await approve()
        assert.equal((await result('BB_OUTPUT')).exitCode, 0)
        assert.equal(await ui.read(`(()=>{const e=${active}.querySelector('.agent-transcript');return e.scrollWidth<=e.clientWidth+1})()`), true)
        await ui.screenshot('automated-narrow-history')
        ui.report('PASS: narrow approval and long history wrap')
        console.log('8 black-box scenarios passed. Records: ' + ui.info.directory)
    } catch (error) {
        await ui.screenshot('automated-failure').catch(() => {})
        ui.report('FAIL: automated black-box suite', String(error))
        throw error
    } finally {
        await ui.call('Emulation.clearDeviceMetricsOverride').catch(() => {})
        ui.close()
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
