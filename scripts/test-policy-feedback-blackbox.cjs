/* Public UI + local model HTTP recorder + disposable SSH; no app service access. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { connect } = require('./agent-blackbox-driver.cjs')
async function main () {
    const ui = await connect()
    const dock = `[...document.querySelectorAll('ash-agent-dock')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().x>=0)`
    const idle = `!!${dock} && !${dock}.querySelector('.stop-button')`
    const events = async scenario => (await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/state`)).json()).events.filter(e => e.scenario === scenario)
    const enter = async text => { await ui.click('.xterm-screen'); await ui.type(text); await ui.key('Enter', 'Enter') }
    const completed = async (scenario, expected) => {
        for (let i = 0; i < 150 && (await events(scenario)).length < expected; i++) await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal((await events(scenario)).length, expected)
        await ui.wait(idle, scenario + ' completed')
    }
    const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(directory, e.name)) : [path.join(directory, e.name)])
    try {
        await ui.wait(`document.body.innerText.includes('Blackbox bash')`, 'fixture ready')
        if (!await ui.read(`!!${dock}`)) await ui.click('.tree-item span', 'Blackbox bash', 'left', 2)
        await ui.wait(`!!${dock} && !${dock}.querySelector('.notice')`, 'terminal ready')
        const unrestricted = process.env.ASH_TEST_APPROVAL_MODE === 'unrestricted'
        if (unrestricted) {
            await enter('BB_GENERATE')
            await completed('BB_GENERATE', 3)
            const records = await events('BB_GENERATE')
            assert.match(records[1].tool.value, /^[a-f0-9]{64}$/)
            assert.equal(records[1].tool.saved, false)
            assert.match(records[2].tool.output, /CHECK_OK/)
            assert.equal(await ui.read(`${dock}.querySelectorAll('.interaction').length`), 0)
            ui.report('PASS: unrestricted autonomous password generation and real SSH execution without forms or vault')
        } else {
            const password = 'LOCAL-QA-quote\'"-$(touch /tmp/blackbox-rejected)-736215'
            await enter("printf 'BASELINE\\n' > /tmp/blackbox-vim.txt")
            await enter('BB_RECOVER')
            await ui.wait(`!!${dock}.querySelector('input[type=password]')`, 'task password form')
            assert.match(await ui.read(`${dock}.innerText`), /仅本次任务使用/)
            assert.equal(await ui.read(`${dock}.querySelectorAll('input[type=checkbox], .credential-picker').length`), 0)
            await ui.click('.interaction input[type=password]'); await ui.type(password)
            await ui.click('.interaction .actions button', '继续')
            await completed('BB_RECOVER', 4)
            const records = await events('BB_RECOVER')
            assert.match(records[1].tool.value, /^__TABBY_SENSITIVE_\d+__$/)
            assert.equal(records[2].tool.executed, false)
            assert.match(records[2].tool.command, /^bash -c/)
            assert.match(records[2].tool.error, /凭证/)
            assert.equal(records[3].tool.exitCode, 0)
            assert.match(records[3].tool.output, /RECOVERY_OK/)
            assert.ok(!JSON.stringify(records).includes(password))
            assert.equal((await (await fetch(`http://127.0.0.1:${ui.info.controlPort}/verify`)).json()).rejectedExists, 'no')
            await ui.screenshot('policy-feedback-recovered')
            await enter('BB_PLAN')
            await ui.wait(`!!${dock}.querySelector('.interaction input[type=text]')`, 'model offers alternatives')
            assert.match(await ui.read(`${dock}.innerText`), /方案 1/)
            assert.equal((await events('BB_PLAN')).length, 2, 'No next operation until necessary user choice')
            await ui.screenshot('policy-feedback-options')
            await ui.click('.interaction input[type=text]'); await ui.type('1')
            await ui.click('.interaction .actions button', '继续')
            await completed('BB_PLAN', 4)
            assert.match((await events('BB_PLAN'))[3].tool.output, /Linux/)
            for (const file of files(ui.info.directory).filter(f => /\.(jsonl|json|yaml)$/.test(f))) {
                assert.ok(!fs.readFileSync(file, 'utf8').includes(password), 'Task password persisted in ' + path.basename(file))
            }
            const histories = files(path.join(ui.info.directory, 'tabby-ai')).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(f, 'utf8')).join('\n')
            assert.ok(histories.includes('policy-feedback') && histories.includes('cat /tmp/.env'), 'Blocked operation retained in local history')
            ui.report('PASS: password form, blocked command/reason, same-task recovery, literal secret transfer, no vault save, alternatives form and continuation')
        }
        assert.equal(ui.errors.length, 0)
        console.log('Policy feedback UI/SSH black-box checks passed')
    } catch (error) {
        await ui.screenshot('policy-feedback-failure').catch(() => {})
        ui.report('FAIL: policy feedback', String(error)); throw error
    } finally { ui.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
