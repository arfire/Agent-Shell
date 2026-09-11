/* Black-box fixture only: fake model + disposable real SSH server + isolated app.
 * Does not access Angular instances, app services, terminal buffers or UI handlers. */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const yaml = require('../tabby-ai/node_modules/js-yaml')
const root = path.resolve(__dirname, '..')
const directory = path.join(root, '.build-cache', 'agent-blackbox-' + Date.now())
const docker = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
const name = 'ash-blackbox-' + crypto.randomBytes(6).toString('hex')
const password = crypto.randomBytes(24).toString('hex')
const events = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let electron, created = false, stopping = false, debugPort, controlPort
fs.mkdirSync(path.join(directory, 'tabby-ai'), { recursive: true })
function dockerRun(args) {
    const result = spawnSync(docker, args, { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    if (result.status !== 0) throw new Error(result.stderr || 'Docker failed')
    return result.stdout.trim()
}
function record(event) {
    events.push({ time: new Date().toISOString(), ...event })
    fs.appendFileSync(path.join(directory, 'model.jsonl'), JSON.stringify(events.at(-1)) + '\n')
}
const commands = {
    BB_STATUS: "test ! -t 0 && test ! -t 1 && printf 'NO_PTY\\n'; printf 'PAGER=%s SYSTEMD_PAGER=%s\\n' \"$PAGER\" \"$SYSTEMD_PAGER\"; cat",
    BB_EXIT: "printf 'BB_STDOUT\\n'; printf 'BB_STDERR\\n' >&2; false",
    BB_STOP: 'sleep 300',
    BB_TIMEOUT: 'sleep 300',
    BB_VERIFY: 'cat /tmp/blackbox-vim.txt',
    BB_WRITE: 'touch /tmp/blackbox-approved',
    BB_REJECT: 'touch /tmp/blackbox-rejected',
    BB_OUTPUT: "seq 1 150; printf 'BB_LONG_" + 'x'.repeat(1200) + "\\n'",
}
const model = http.createServer(async (req, res) => {
    try {
        let body = ''
        for await (const chunk of req) body += chunk
        const request = JSON.parse(body)
        const input = request.messages.filter(m => m.role === 'user').at(-1)?.content || ''
        const scenario = Object.keys(commands).find(key => input.includes(key)) || (/BB_[A-Z_]+/.exec(input)?.[0] ?? 'BB_TEXT')
        const tool = request.messages.at(-1)?.role === 'tool' ? JSON.parse(request.messages.at(-1).content) : null
        record({ scenario, tool, model: request.model })
        if (scenario === 'BB_HTTP_ERROR') { res.writeHead(503); res.end('Black-box injected unavailable'); return }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = value => res.write('data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n')
        if (scenario === 'BB_BROKEN_STREAM') { delta({ content: '未完成片段' }); res.end(); return }
        if (!tool && commands[scenario]) {
            delta({ tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: commands[scenario], reason: '黑盒测试 ' + scenario }) } }] })
        } else if (tool) {
            delta({ content: `${scenario} RESULT ${JSON.stringify(tool)}\n` })
        } else {
            for (const chunk of ['BB_TEXT_OK ', '中文输入正常。', '只回答本次请求。\n']) { delta({ content: chunk }); await delay(150) }
        }
        res.end('data: [DONE]\n\n')
    } catch (error) { record({ error: String(error) }); res.destroy() }
})
function launch() {
    const log = fs.openSync(path.join(directory, 'electron.log'), 'a')
    electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(directory, 'bootstrap.cjs'), '--remote-debugging-port=' + debugPort], {
        cwd: root, windowsHide: true, stdio: ['ignore', log, log],
        env: { ...process.env, TABBY_DEV: '1', TABBY_DATA_DIRECTORY: directory, TABBY_CONFIG_DIRECTORY: directory },
    })
    fs.closeSync(log)
}
async function stop() {
    if (stopping) return
    stopping = true
    electron?.kill()
    if (created) dockerRun(['stop', '--time', '1', name])
    model.close(); control.close()
}
const control = http.createServer(async (req, res) => {
    try {
        if (req.url === '/state') res.end(JSON.stringify({ directory, debugPort, name, events }))
        else if (req.url === '/verify') res.end(JSON.stringify({ file: dockerRun(['exec', name, 'sh', '-c', 'cat /tmp/blackbox-vim.txt']), rejectedExists: dockerRun(['exec', name, 'sh', '-c', 'if test -e /tmp/blackbox-rejected; then echo yes; else echo no; fi']) }))
        else if (req.url === '/restart' && req.method === 'POST') {
            const exited = new Promise(resolve => electron.once('exit', resolve)); electron.kill(); await exited; launch(); res.end('restarted')
        } else if (req.url === '/disconnect' && req.method === 'POST') {
            dockerRun(['exec', name, 'sh', '-c', 'pkill -u ashbash || true']); res.end('disconnected')
        } else if (req.url === '/stop' && req.method === 'POST') { res.end('stopped'); await stop() }
        else { res.writeHead(404); res.end() }
    } catch (error) { res.writeHead(500); res.end(String(error)) }
})
async function main() {
    dockerRun(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', '-e', 'ASH_TEST_PASSWORD=' + password, 'ash-native-agent-test:local'])
    created = true
    const sshPort = Number(JSON.parse(dockerRun(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))['22/tcp'][0].HostPort)
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    await new Promise(resolve => control.listen(0, '127.0.0.1', resolve)); controlPort = control.address().port
    const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); debugPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
    const config = yaml.load(fs.readFileSync(path.join(root, 'tabby-ai/default-config.yaml'), 'utf8'))
    config.llm = { ...config.llm, baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'blackbox-local', timeout: 6000 }
    fs.writeFileSync(path.join(directory, 'tabby-ai/config.yaml'), yaml.dump(config))
    fs.writeFileSync(path.join(directory, 'config.yaml'), yaml.dump({
        version: 7, enableAnalytics: false, terminal: { frontend: 'xterm', fontSize: 16, rightClick: 'menu', copyOnSelect: false },
        appearance: { colorScheme: 'dark' }, ssh: { verifyHostKeys: false }, recovery: [],
        profiles: ['bash', 'zsh', 'fish'].map(shell => ({ id: 'blackbox-' + shell, type: 'ssh', name: 'Blackbox ' + shell,
            options: { host: '127.0.0.1', port: sshPort, user: 'ash' + shell, auth: 'password', password, reuseSession: false } })),
    }))
    fs.writeFileSync(path.join(directory, 'bootstrap.cjs'), `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.join(root, 'app'))});app.requestSingleInstanceLock=()=>true;app.setAsDefaultProtocolClient=()=>false;require(${JSON.stringify(path.join(root, 'app/dist/main.js'))});`)
    launch()
    const info = { directory, debugPort, controlPort, name }
    fs.writeFileSync(path.join(root, '.build-cache/agent-blackbox-current.json'), JSON.stringify(info, null, 2))
    console.log(JSON.stringify(info))
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
main().catch(async error => { console.error(error); await stop(); process.exitCode = 1 })
