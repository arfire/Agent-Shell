/* Real non-PTY SSH sudo regression; disposable server and synthetic password only. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const ts = require('../node_modules/typescript')
const russh = require('../app/node_modules/russh')
const root = path.resolve(__dirname, '..')
const docker = process.env.ASH_TEST_DOCKER || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
const cache = new Map()
function load (file) {
    const filename = path.resolve(root, file)
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
    const localRequire = id => {
        if (id === '@angular/core') return { Injectable: () => value => value }
        if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id + '.ts'))
        return require(id)
    }
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(localRequire, module, module.exports)
    return module.exports
}
function run (args) {
    const result = spawnSync(docker, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 120000 })
    if (result.status !== 0) throw new Error(result.stderr || 'Docker command failed')
    return result.stdout.trim()
}
const name = 'ash-sudo-regression-' + crypto.randomBytes(6).toString('hex')
const password = crypto.randomBytes(24).toString('hex') + '\'"$()%\\'
let created = false
let client
async function main () {
    run(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', '-e', 'ASH_TEST_PASSWORD=' + password, 'ash-native-agent-test:local'])
    created = true
    run(['exec', '-u', 'root', name, 'sh', '-c', 'apk add --no-cache sudo >/dev/null && mkdir -p /etc/sudoers.d && printf "%s\\n" "Defaults timestamp_type=ppid" "ashbash ALL=(ALL) ALL" "ashzsh ALL=(ALL) ALL" "ashfish ALL=(ALL) ALL" > /etc/sudoers.d/ash-regression && chmod 440 /etc/sudoers.d/ash-regression'])
    const port = JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))['22/tcp'][0].HostPort
    const { executeSSH } = load('tabby-ai/src/terminal/ssh-exec.ts')
    const { SecretRedactor } = load('tabby-ai/src/policy/secret-redactor.ts')
    const { credentialAccessReason } = load('tabby-ai/src/policy/credential-guard.ts')
    const defaults = require('../tabby-ai/node_modules/js-yaml').load(fs.readFileSync(path.join(root, 'tabby-ai/default-config.yaml'), 'utf8'))
    for (const shell of ['bash', 'zsh', 'fish']) {
        client = await russh.SSHClient.connect(await russh.SshTransport.newSocket('127.0.0.1:' + port), async () => true)
        client = await client.authenticateWithPassword('ash' + shell, password)
        assert.ok(client instanceof russh.AuthenticatedSSHClient)
        const scope = new SecretRedactor({ config: defaults, knownSecrets: new Set() }).createScope()
        const token = scope.registerSecret(password, { program: 'sudo', target: 'current-server' })
        const execute = async command => {
            assert.equal(scope.useReason(command), undefined, command)
            assert.equal(credentialAccessReason(command), undefined, command)
            return executeSSH(async () => client.activateChannel(await client.openSessionChannel()),
                scope.restoreCommand(command, shell), shell, () => undefined, undefined, 15000)
        }
        const authentication = `printf '%s\\n' '${token}' | sudo -S -v`
        if (shell === 'bash') {
            const before = await executeSSH(async () => client.activateChannel(await client.openSessionChannel()),
                scope.restoreCommand(authentication.replace('-S -v', '-S -k -v') + ' && sudo -n true', shell),
                shell, () => undefined, undefined, 15000)
            assert.notEqual(before.exitCode, 0, 'old -k -v recipe does not cache authentication even in one SSH call')
        }
        if (shell === 'zsh') {
            const before = await executeSSH(async () => {
                const channel = await client.activateChannel(await client.openSessionChannel())
                const request = channel.requestExec.bind(channel)
                channel.requestExec = command => request(command.replace('\nash_exec_exit=$?; exit "$ash_exec_exit"\n', '\n'))
                return channel
            }, scope.restoreCommand(authentication + ' && sudo -n true', shell), shell, () => undefined, undefined, 15000)
            assert.notEqual(before.exitCode, 0, 'old Zsh envelope changes the final sudo parent process')
        }
        assert.equal((await execute(authentication)).exitCode, 0)
        assert.notEqual((await execute('sudo -n true')).exitCode, 0, 'separate SSH process cannot reuse authentication')
        const directory = '/opt/ash-gitea-' + shell
        const deploy = authentication + ` && sudo -n mkdir -p ${directory}/data && sudo -n chown ash${shell}:ash${shell} ${directory}`
        const deployed = await execute(deploy)
        assert.equal(deployed.exitCode, 0, 'combined validation and operations: ' + shell + ': ' + deployed.output)
        const compose = `cat > ${directory}/docker-compose.yml <<'EOF'\nservices:\n  gitea:\n    image: gitea/gitea:latest\n    environment:\n      - USER_UID=1000\nEOF`
        // Fish does not support POSIX heredocs; use the literal write-only Python form instead.
        const write = shell === 'fish' ? `python3 -c "import pathlib; pathlib.Path('${directory}/docker-compose.yml').write_text('services: {}')"` : compose
        assert.equal((await execute(write)).exitCode, 0, 'configuration write: ' + shell)
        assert.equal((await execute(`test -s ${directory}/docker-compose.yml`)).exitCode, 0)
        assert.equal((await execute(authentication + ` && sudo -n test -d ${directory}/data`)).exitCode, 0, 'subsequent call authenticates again')
        assert.equal((await execute(authentication + ' && sudo -n cat')).output.includes(password), false, 'operation receives EOF, never password stdin')
        const wrong = scope.registerSecret('synthetic-wrong-password', { program: 'sudo', target: 'current-server' })
        assert.notEqual((await execute(`printf '%s\\n' '${wrong}' | sudo -S -v && sudo -n mkdir /opt/ash-must-not-exist`)).exitCode, 0)
        assert.equal((await execute('test ! -e /opt/ash-must-not-exist')).exitCode, 0)
        scope.clear()
        await client.disconnect()
        client = undefined
        console.log('PASS', shell, 'non-PTY sudo, independent calls, deployment writes, password isolation and failed authentication')
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
    await client?.disconnect().catch(() => {})
    if (created) run(['stop', '--time', '2', name])
})
