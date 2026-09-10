/* Node 22 + disposable loopback-only OpenSSH container. No saved profiles. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const ts = require('../node_modules/typescript')
const russh = require('../app/node_modules/russh')
const root = path.resolve(__dirname, '..')
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
        // transpileModule cannot inline the const enum as the production compiler does.
        if (id === 'russh') return { ...russh, SFTPFileType: require('../app/node_modules/russh/lib/native').SftpFileType }
        if (id === 'tabby-core') return load('tabby-core/src/api/platform.ts')
        if (id === '@angular/core') return {}
        if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id + '.ts'))
        return require(id)
    }
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(localRequire, module, module.exports)
    return module.exports
}
const docker = process.env.ASH_TEST_DOCKER || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
function run (args) {
    const result = spawnSync(docker, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 })
    if (result.status !== 0) throw new Error(result.stderr || 'Docker command failed')
    return result.stdout.trim()
}
const name = 'ash-sftp-test-' + crypto.randomBytes(6).toString('hex')
const password = crypto.randomBytes(24).toString('hex')
let created = false
let client
async function main () {
    run(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', '-e', 'ASH_TEST_PASSWORD=' + password, 'ash-native-agent-test:local'])
    created = true
    const port = JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))['22/tcp'][0].HostPort
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            client = await russh.SSHClient.connect(await russh.SshTransport.newSocket('127.0.0.1:' + port), async () => true)
            break
        } catch (error) {
            if (attempt === 29) throw error
            await new Promise(resolve => setTimeout(resolve, 200))
        }
    }
    client = await client.authenticateWithPassword('ashbash', password)
    assert.ok(client instanceof russh.AuthenticatedSSHClient)
    const native = await client.activateSFTP(await client.openSessionChannel())
    const { SFTPSession } = load('tabby-ssh/src/session/sftp.ts')
    const sftp = new SFTPSession(native, { get: () => ({ create: () => ({ debug () {}, info () {}, warn: console.warn, error: console.error }) }) })
    await load('tabby-ssh/src/session/sftp.spec.ts').runTests(async (label, test) => {
        await test()
        console.log('PASS', label)
    }, load, sftp, native)
    if (process.env.ASH_TEST_SFTP_UI === '1') {
        const result = spawnSync(process.execPath, [path.join(__dirname, 'test-native-agent-ui.cjs')], {
            cwd: root, windowsHide: true, stdio: 'inherit', timeout: 120000,
            env: { ...process.env, ASH_TEST_SSH_PORT: port, ASH_TEST_PASSWORD: password, ASH_TEST_SFTP_ONLY: '1' },
        })
        assert.equal(result.status, 0, 'Electron SFTP UI checks failed')
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
    await client?.disconnect().catch(() => {})
    if (created) run(['stop', '--time', '2', name])
})
