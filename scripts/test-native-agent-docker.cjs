/* Disposable, loopback-only OpenSSH server. No user volumes or saved profiles. */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const docker = process.env.ASH_TEST_DOCKER || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
function run (args) {
    const result = spawnSync(docker, args, { cwd: root, windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || 'Docker command failed')
    return result.stdout.trim()
}
const name = 'ash-native-agent-test-' + crypto.randomBytes(6).toString('hex')
const password = crypto.randomBytes(24).toString('hex')
let created = false
try {
    run(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', '-e', 'ASH_TEST_PASSWORD=' + password, 'ash-native-agent-test:local'])
    created = true
    const port = JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))['22/tcp'][0].HostPort
    for (const shell of (process.env.ASH_TEST_SHELLS || 'bash,zsh,fish').split(',')) {
        console.log('Testing real SSH:', shell)
        const result = spawnSync(process.execPath, [path.join(__dirname, 'test-native-agent-ui.cjs')], {
            cwd: root, windowsHide: true, stdio: 'inherit',
            env: { ...process.env, ASH_TEST_SSH_PORT: port, ASH_TEST_PASSWORD: password, ASH_TEST_SHELL: shell },
        })
        if (result.status !== 0) throw new Error(shell + ' SSH UI check failed')
    }
} finally {
    if (created) {
        fs.writeFileSync(path.join(root, '.build-cache/native-agent-sshd.log'), run(['logs', name]))
        run(['stop', '--time', '2', name])
    }
}
