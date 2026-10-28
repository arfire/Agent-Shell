const assert = require('node:assert/strict')
const pty = require('../app/node_modules/node-pty')
const { BehaviorSubject } = require('../node_modules/rxjs')
const { load, XTermFrontend, detector, tick } = require('./test-native-agent.cjs')
const { ShellIntegration } = load('tabby-ai/src/terminal/shell-integration.ts')
const { AIInputMiddleware } = load('tabby-ai/src/terminal/ai-input.middleware.ts')
const { CommandFramingMiddleware } = load('tabby-ai/src/terminal/command-framing.middleware.ts')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function check (kind, file, args, env = {}) {
    const terminal = new XTermFrontend(), agent = [], sent = []
    let writing = Promise.resolve(), raw = ''
    const runtime = {
        id: kind, locked: false, state: new BehaviorSubject('IDLE'),
        terminal: new BehaviorSubject({ mode: 'agent', ready: false, notice: '', state: 'initializing' }),
        tab: { frontend: terminal, write: text => writing = writing.then(() => new Promise(resolve => terminal.xterm.write(text, resolve))) },
    }
    const shell = new ShellIntegration(() => runtime.tab.write(''))
    const input = new AIInputMiddleware(runtime, { append: async () => {} }, detector, shell, text => agent.push(text), () => {})
    const framing = new CommandFramingMiddleware()
    const process = pty.spawn(file, args, { name: 'xterm-256color', cols: 40, rows: 12, useConptyDll: true, env: { ...global.process.env, TERM: 'xterm-256color', ...env } })
    const writeRemote = data => { sent.push(data.toString()); process.write(data.toString()) }
    shell.outputToSession$.subscribe(writeRemote)
    input.outputToSession$.subscribe(data => framing.feedFromTerminal(data))
    framing.outputToSession$.subscribe(writeRemote)
    shell.outputToTerminal$.subscribe(data => framing.feedFromSession(data))
    framing.outputToTerminal$.subscribe(data => input.feedFromSession(data))
    input.outputToTerminal$.subscribe(data => runtime.tab.write(data.toString()))
    terminal.xterm.onData(data => input.feedFromTerminal(Buffer.from(data)))
    process.onData(data => { raw = (raw + data).slice(-30000); shell.feedFromSession(Buffer.from(data)) })
    shell.setShell(kind)
    const wait = async (condition, message) => {
        const end = Date.now() + 16000
        while (!condition() && Date.now() < end) await delay(30)
        if (!condition()) throw new Error(message + '\nState=' + shell.state.value + '\nOutput=' + JSON.stringify(raw.slice(-3500)))
        await input.settled(); await runtime.tab.write(''); await tick()
    }
    try {
        console.log(kind, 'waiting for installation')
        await wait(() => shell.ready, 'Integration failed to reach a prompt')
        console.log(kind, 'installed')
        assert.equal(shell.installed, true)
        const initialWrites = sent.length
        input.feedFromTerminal(Buffer.from('帮我检查日志')); await input.settled()
        assert.equal(sent.length, initialWrites, 'Natural language leaked to PTY')
        input.submit('agent'); await input.settled()
        assert.deepEqual(agent, ['帮我检查日志'])
        await runtime.tab.write('Agent\r\n这是同一个终端中的回答。\r\n')
        await shell.redraw(); runtime.locked = false
        console.log(kind, 'redrawn')
        await wait(() => shell.ready, 'Prompt did not recover after Agent output')
        input.feedFromTerminal(Buffer.from('echo ASH_COMMAND_OK\r')); await input.settled()
        await wait(() => shell.ready && raw.includes('ASH_COMMAND_OK'), 'User shell command failed')
        shell.commandStarted()
        let frameTimer
        const result = await Promise.race([
            framing.execute(kind === 'powershell' ? 'Write-Output ASH_FRAMED_OK' : 'printf ASH_FRAMED_OK', input, undefined, undefined, undefined, kind),
            new Promise((_, reject) => { frameTimer = setTimeout(() => reject(new Error('Framing timeout: ' + JSON.stringify(raw.slice(-5000)))), 12000) }),
        ]).finally(() => clearTimeout(frameTimer))
        assert.equal(result.exitCode, 0)
        assert.match(result.output, /ASH_FRAMED_OK/)
        await wait(() => shell.ready, 'Framed command did not restore prompt')
        shell.disable()
        await wait(() => !shell.installed, 'Uninstall did not complete')
        assert.equal(shell.mode.value, 'shell')
        input.feedFromTerminal(Buffer.from('echo ASH_AFTER_UNINSTALL\r'))
        await wait(() => raw.includes('ASH_AFTER_UNINSTALL'), 'Shell failed after uninstall')
        console.log('PASS', kind, 'real PTY: install, local input, native output, prompt recovery, execution framing, uninstall')
    } finally {
        process.kill()
        await delay(250)
        shell.close(); input.close(); framing.close(); terminal.xterm.dispose()
    }
}
async function main () {
    await check('bash', 'C:\\Program Files\\Git\\bin\\bash.exe', ['--noprofile', '--norc', '-i'], { PS1: 'ASH-TEST> ' })
    await check('powershell', global.process.env.ASH_TEST_PWSH || 'pwsh.exe', ['-NoLogo', '-NoProfile'])
}
// ConPTY may retain worker handles after its child shell has been terminated.
main().then(() => global.process.exit(0)).catch(error => { console.error(error); global.process.exit(1) })
