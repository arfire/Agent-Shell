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
let linkVisits = 0
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
    BB_UNAME: 'uname -s',
    BB_ROUTINE: 'df -h',
    BB_LONG_PROGRESS: "for i in $(seq 1 130); do printf 'abcdef123456 Downloading %sMB\\n' \"$i\"; sleep 1; done; printf 'DOWNLOAD_COMPLETE\\n'",
    BB_PROGRESS_STOP: "for i in $(seq 1 300); do printf 'abcdef123456 Downloading %sMB\\n' \"$i\"; sleep 1; done",
    BB_RAW: 'cat /tmp/ash-disclosure-value.txt',
    BB_PROTECTED: 'cat /tmp/.env',
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
        record({ scenario, tool, model: request.model, ...(process.env.ASH_TEST_CREDENTIALS ? { authorized: req.headers.authorization === 'Bearer LOCAL_BLACKBOX_MODEL_KEY_791364' } : {}),
            ...(process.env.ASH_TEST_CREDENTIALS || process.env.ASH_TEST_DISCLOSURE ? { request } : {}) })
        if (scenario === 'BB_HTTP_ERROR') { res.writeHead(503); res.end('Black-box injected unavailable'); return }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = value => res.write('data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n')
        if (scenario === 'BB_BROKEN_STREAM') { delta({ content: '未完成片段' }); res.end(); return }
        if (scenario === 'BB_RECOVER') {
            const values = request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content))
            const credential = values.find(v => v.value)?.value
            let name = 'terminal_exec', args
            if (!tool) { name = 'request_user_input'; args = { prompt: '恢复流程测试密码', kind: 'secret', program: 'curl', target: 'http://127.0.0.1:18081' } }
            else if (tool.value) { args = { command: `bash -c "test -n ${credential}"`, reason: '测试不支持的密码嵌套写法' } }
            else if (tool.executed === false) { args = { command: `curl --disable --noproxy "*" --fail -H "Authorization: Bearer ${credential}" http://127.0.0.1:18081/recover`, reason: '改用已绑定目标，仅验证密码传入' } }
            else { delta({ content: 'BB_RECOVER_DONE' }) }
            if (args) delta({ tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        } else if (scenario === 'BB_PLAN') {
            let name = 'terminal_exec', args
            if (!tool) { args = { command: 'cat /tmp/.env', reason: '测试受限凭据读取' } }
            else if (tool.executed === false) { name = 'request_user_input'; args = { kind: 'text', prompt: '读取凭据被阻止。方案 1：只检查系统版本（推荐，无需密码）；方案 2：结束检查。请输入 1 或 2。' } }
            else if (tool.value === '1') { args = { command: 'uname -s', reason: '按用户选择检查系统版本' } }
            else { delta({ content: 'BB_PLAN_DONE' }) }
            if (args) delta({ tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        } else if (['BB_CREDENTIAL', 'BB_GENERATE'].includes(scenario) && !tool) {
            const name = scenario === 'BB_GENERATE' ? 'generate_secret' : 'request_user_input'
            const args = name === 'generate_secret' ? { description: '黑盒测试 · 随机服务密钥' } : { prompt: '测试服务密码', kind: 'secret', program: 'curl', target: 'http://127.0.0.1:18081' }
            delta({ tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        } else if (['BB_CREDENTIAL', 'BB_GENERATE'].includes(scenario) && tool?.value) {
            delta({ tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name: 'terminal_exec',
                arguments: JSON.stringify({ command: scenario === 'BB_GENERATE' ? `test -n "${tool.value}" && printf 'CHECK_OK\\n'` : `curl --disable --noproxy "*" --fail -H "Authorization: Bearer ${tool.value}" http://127.0.0.1:18081/check`, reason: '在服务器上验证本地凭证已传入，仅输出检查结果' }) } }] })
        } else if (!tool && commands[scenario]) {
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
        if (req.url === '/state') res.end(JSON.stringify({ directory, debugPort, name, events, linkVisits }))
        else if (req.url === '/link-target') { linkVisits++; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>Ash local link test</title><p>Ash 本地链接点击验证完成，可以关闭此页。</p>') }
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
    dockerRun(['exec', '-d', name, 'python3', '-u', '-c', `
from http.server import BaseHTTPRequestHandler, HTTPServer
class Check(BaseHTTPRequestHandler):
    def do_GET(self):
        authorized = self.headers.get('Authorization', '').startswith('Bearer ')
        self.send_response(200 if authorized else 401)
        self.end_headers()
        self.wfile.write(('RECOVERY_OK\\n' if self.path == '/recover' else 'CHECK_OK\\n').encode() if authorized else b'')
    def log_message(self, *_args):
        pass
HTTPServer(('127.0.0.1', 18081), Check).serve_forever()
`])
    dockerRun(['exec', name, 'sh', '-c', "printf '%s\\n' 'LOCAL_UNLABELLED_635192' > /tmp/ash-disclosure-value.txt"])
    const sshPort = Number(JSON.parse(dockerRun(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))['22/tcp'][0].HostPort)
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    await new Promise(resolve => control.listen(0, '127.0.0.1', resolve)); controlPort = control.address().port
    const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); debugPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
    const config = yaml.load(fs.readFileSync(path.join(root, 'tabby-ai/default-config.yaml'), 'utf8'))
    config.llm = { ...config.llm, baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'blackbox-local', timeout: 6000 }
    if (['full', 'unrestricted'].includes(process.env.ASH_TEST_APPROVAL_MODE)) config.policy.approvalMode = process.env.ASH_TEST_APPROVAL_MODE
    if (process.env.ASH_TEST_CREDENTIALS) { config.llm.apiKey = 'LOCAL_BLACKBOX_MODEL_KEY_791364' }
    fs.writeFileSync(path.join(directory, 'tabby-ai/config.yaml'), yaml.dump(config))
    fs.writeFileSync(path.join(directory, 'config.yaml'), yaml.dump({
        version: 7, enableAnalytics: false, terminal: { frontend: 'xterm', fontSize: 16, rightClick: 'menu', copyOnSelect: false },
        appearance: { colorScheme: 'dark' }, ssh: { verifyHostKeys: false }, recovery: [],
        profiles: ['bash', 'zsh', 'fish'].map(shell => ({ id: 'blackbox-' + shell, type: 'ssh', name: 'Blackbox ' + shell,
            options: { host: '127.0.0.1', port: sshPort, user: 'ash' + shell, auth: 'password', password, reuseSession: false } })),
    }))
    fs.writeFileSync(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');require(${JSON.stringify(path.join(root, 'scripts/agent-blackbox-window.cjs'))}).attach(app,BrowserWindow,${JSON.stringify(directory)});app.setAppPath(${JSON.stringify(path.join(root, 'app'))});app.requestSingleInstanceLock=()=>true;app.setAsDefaultProtocolClient=()=>false;require(${JSON.stringify(path.join(root, 'app/dist/main.js'))});`)
    launch()
    const info = { directory, debugPort, controlPort, name }
    fs.writeFileSync(path.join(root, '.build-cache/agent-blackbox-current.json'), JSON.stringify(info, null, 2))
    console.log(JSON.stringify(info))
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
main().catch(async error => { console.error(error); await stop(); process.exitCode = 1 })
