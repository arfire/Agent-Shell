const assert = require('node:assert/strict')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    const ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const idle = `!!${dock} && !${dock}.querySelector('.stop-button')`
    try {
        await ui.wait(`document.body.innerText.includes('Blackbox bash')`, 'fixture ready')
        if (!await ui.read(`!!${dock}`)) await ui.click('.tree-item span', 'Blackbox bash', 'left', 2)
        await ui.wait(`!!${dock} && !${dock}.querySelector('.notice')`, 'terminal ready')
        await ui.click('.xterm-screen')
        await ui.type('BB_RAW')
        await ui.key('Enter', 'Enter')
        await ui.wait(`!!${dock}.querySelector('.interaction textarea')`, 'command execution approval')
        await ui.click('button', '允许执行')
        await ui.wait(idle, 'arbitrary command result returns without another confirmation')
        const events = (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events
        assert.equal(events.filter(e => e.scenario === 'BB_RAW').at(-1).tool.output.trim(), 'LOCAL_UNLABELLED_635192')
        assert.equal(await ui.read(`${dock}.querySelectorAll('.interaction').length`), 0)
        ui.report('PASS: command result returns automatically, no output confirmation UI')
        await ui.screenshot('automatic-command-result')
        console.log('Automatic result black-box check passed')
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
