import * as assert from 'node:assert/strict'
import { BehaviorSubject } from 'rxjs'
import { credentialAccessReason } from './credential-guard'
import { SecretRedactor } from './secret-redactor'
import { AgentService } from '../agent/agent.service'
import { CommandPolicyService } from './command-policy.service'
import { AgentPermissionsService } from './agent-permissions.service'
import { AIConfig } from '../config/config-schema'
import { AISessionCaptureMiddleware } from '../terminal/session-capture.middleware'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, defaults: AIConfig): Promise<void> {
    await test('writing deployment configuration is distinct from reading existing configuration', async () => {
        const compose = 'mkdir -p /opt/gitea/data && cat > /opt/gitea/docker-compose.yml <<\'EOF\'\nservices:\n  gitea:\n    image: gitea/gitea:latest\n    environment:\n      - USER_UID=1000\nEOF\necho "配置文件已创建"'
        const python = 'python3 -c "import pathlib; pathlib.Path(\'/home/hehong/gitea/docker-compose.yml\').write_text(\'services: {}\'); print(\'OK\')"'
        for (const mode of ['configured', 'auto', 'full', 'unrestricted'] as const) {
            for (const command of [compose, python, 'cat <<\'EOF\' > /tmp/compose.yaml\nservices: {}\nEOF',
                'docker compose -f /home/hehong/gitea/docker-compose.yml config --quiet', 'docker compose config -q']) {
                assert.equal(credentialAccessReason(command, mode), undefined, command)
            }
        }
        for (const command of ['cat /tmp/compose.yaml > /tmp/copy.txt', 'cat < /tmp/compose.yaml', 'cat appsett""ings.json', 'cat appsett\\ings.json',
            'python3 -c "import pathlib; print(pathlib.Path(\'compose.yaml\').read_text())"',
            'docker compose -f /tmp/compose.yaml config --quiet; cat .env', 'docker compose config']) {
            assert.ok(credentialAccessReason(command), command)
        }
    })
    await test('normal archives, diagnostics and public shell syntax are not credential access', async () => {
        for (const command of ['tar --version', 'tar -xf release.tar -C /tmp/app', 'tar cf /tmp/release.tar /srv/app',
            'cat /var/log/*.log', 'grep "[ERROR]" /var/log/app.log', 'rg -i password /app', 'cat "$APP_DIR/README.md"',
            'echo "${APP_DIR}"', 'echo "$PWD"', 'printf hello | base64',
            'docker inspect --format "{{.State.Status}}" gitea',
            'python3 -c "print(open(\'/tmp/README.md\').read())"',
            'python -c "exec(code)"', 'sh -c "eval $code"', 'powershell -EncodedCommand ZQB4AGkAdAA=']) {
            assert.equal(credentialAccessReason(command), undefined, command)
        }
    })
    const blocked = [
        'grep -E "MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD" .env', 'cat /app/.env.production',
        'sudo -u root cat ~/.ssh/id_ed25519', 'command head .aws/credentials',
        'sh -c "cat /app/.env"', 'python -c "print(open(\'.env\').read())"',
        'node -e "console.log(process.env)"', 'cat < .env', 'cp .env /tmp/copy',
        'cat .e""nv', 'cat .e\\nv', 'cat /proc/self/environ', 'cat /etc/shadow',
        'cat ~/.docker/config.json', 'cat ~/.kube/config', 'cat ~/.git-credentials',
        'printenv', 'env -0 | sort', 'set', 'export -p', 'declare -p',
        'echo "$MYSQL_ROOT_PASSWORD"', 'Get-ChildItem Env:', '[Environment]::GetEnvironmentVariable("DB_PASSWORD")',
        'docker inspect mysql', 'podman container inspect mysql', 'docker compose config',
        'docker exec db printenv', 'kubectl get secret/db -o yaml', 'kubectl config view --raw',
        'aws secretsmanager get-secret-value --secret-id db', 'aws configure get aws_secret_access_key',
        'az account get-access-token', 'vault kv get secret/db',
        'cat appsettings.json', 'curl http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        'jq .services docker-compose.yml', 'yq .database application.yaml', 'rg host settings.ini',
        'python -c "print(open(\'settings.toml\').read())"', 'cp application.yaml /tmp/public.txt',
        'mysql -e "SELECT * FROM mysql.user"', 'psql -c "SELECT * FROM pg_authid"',
        'python -c "print(open(\'.\'+\'env\').read())"', 'printf Y2F0IC5lbnY= | base64 -d | sh',
        'mysql -u root -p123456 db -e "SHOW TABLES"', 'mysql --password=guess', 'MYSQL_PWD=guess mysql',
    ]
    await test('credential boundary rejects common reads, exports, wrappers, searches and guessed passwords', async () => {
        for (const command of blocked) { assert.ok(credentialAccessReason(command), command) }
        for (const command of ['pwd', 'ls -la', 'docker compose ps', 'docker compose up -d', 'git status',
            'mysql -u root -p__TABBY_SENSITIVE_1__ db -e "SHOW TABLES"',
            'MYSQL_PWD=__TABBY_SENSITIVE_1__ mysql db -e "SHOW TABLES"', 'mysql -P3306 -u root -p', 'printf "test\\n"']) {
            assert.equal(credentialAccessReason(command), undefined, command)
        }
    })
    await test('credential boundary cannot be bypassed in the first three tiers or by edited approval', async () => {
        for (const mode of ['configured', 'auto', 'full']) {
            const config = { config: { ...defaults, policy: { ...defaults.policy, approvalMode: mode } } }
            const redactor = new SecretRedactor({ ...config, knownSecrets: new Set() } as any)
            let executions = 0
            let edited = 'cat .env'
            const service: any = new AgentService(config as any, null as any, null as any,
                new CommandPolicyService(config as any), redactor, { append: async () => ({}) } as any,
                { request: async () => ({ approved: true, command: edited }) } as any, null as any,
                { execute: async () => { executions++; return { output: '', exitCode: 0 } } } as any,
                { interrupt: async () => undefined, open: async () => undefined } as any, new AgentPermissionsService(config as any, null as any))
            const runtime = { id: 'guard', state: new BehaviorSubject('THINKING'), events: new BehaviorSubject([]) }
            const run = { id: 'run', controller: new AbortController(), stopRequested: false, sensitive: redactor.createScope() }
            for (const command of blocked) {
                await assert.rejects(service.executeTool(runtime, run, { 'function': { name: 'terminal_exec', arguments: JSON.stringify({ command, reason: 'Test' }) } }), /凭证保护/, mode + ': ' + command)
            }
            // Exercise the final execution boundary directly (after all approval edits).
            for (const command of blocked) {
                await assert.rejects(service.executeApprovedCommand(runtime, run, command, 'Test', { risk: 'SAFE' }, { mode, policy: config.config.policy }), /凭证保护/)
            }
            if (mode === 'configured') {
                for (const command of ['cat .env', 'mysql -pguess', 'docker inspect db']) {
                    edited = command
                    await assert.rejects(service.executeTool(runtime, run, { 'function': { name: 'terminal_exec', arguments: '{"command":"touch /tmp/test","reason":"Test"}' } }), /凭证保护/)
                }
            }
            assert.equal(executions, 0)
        }
    })
    await test('credential fields and MySQL arguments are redacted while local placeholders remain usable', async () => {
        for (const enabled of [true, false]) {
            const redactor = new SecretRedactor({ knownSecrets: new Set(), config: { ...defaults, redaction: { ...defaults.redaction, enabled } } } as any)
            for (const source of ['MYSQL_ROOT_PASSWORD=test-secret', 'MYSQL_PASSWORD="test-secret"',
                '{"db_password":"test-secret"}', 'mysql -u root -ptest-secret db', 'PGPASSWORD=test-secret']) {
                assert.equal(redactor.redact(source).includes('test-secret'), false, source)
            }
            assert.equal(redactor.redact('using password: YES'), 'using password: YES')
            const scope = redactor.createScope()
            const token = scope.register('local-test-value')
            assert.equal(scope.restore(scope.protect('MYSQL_PWD=' + token)), 'MYSQL_PWD=local-test-value')
            const special = scope.register('a\'b"$(`whoami`)\\c')
            assert.equal(scope.restoreCommand('mysql -p' + special), 'mysql -p\'a\'\\\'\'b"$(`whoami`)\\c\'')
            assert.equal(scope.restoreCommand('mysql -p"' + special + '"'), 'mysql -p"a\'b\\"\\$(\\`whoami\\`)\\\\c"')
            assert.throws(() => scope.restoreCommand('mysql -p__TABBY_SENSITIVE_999__'), /占位符已失效/)
        }
    })
    await test('unrestricted allows protected commands and raw results while lower tiers remain redacted', async () => {
        for (const command of blocked) { assert.equal(credentialAccessReason(command, 'unrestricted'), undefined) }
        let unrestricted = true
        const redactor = new SecretRedactor({ knownSecrets: new Set(), config: defaults } as any)
        const scope = redactor.createScope(() => unrestricted)
        const output = 'DB_PASSWORD=synthetic-permission-test\n'
        const filter = scope.streamFilter(true)
        assert.equal(filter(output) + filter.flush(), output)
        assert.equal(scope.protect(output), output)
        assert.equal(scope.redactKnown(output), output)
        assert.equal(redactor.redact(output).includes('synthetic-permission-test'), false)
        unrestricted = false
        assert.equal(scope.protect(output).includes('synthetic-permission-test'), false)
        assert.equal(filter(output).includes('synthetic-permission-test'), false)
    })
    await test('unknown credential output is hidden across every transport split including private key bodies', async () => {
        const redactor = new SecretRedactor({ knownSecrets: new Set(), config: defaults } as any)
        for (const source of ['MYSQL_ROOT_PASSWORD=test-secret\r\nnext\n', '{"MYSQL_PASSWORD":"test-secret"}\n',
            'MYSQL_\x1b[31mPASSWORD=test-secret\x1b[0m\n', 'DB_PASSWORD="test-secret\nPRIVATEBODY"\nnext\n',
            '-----BEGIN PRIVATE KEY-----\nPRIVATEBODY\n-----END PRIVATE KEY-----\nnext\n']) {
            for (let split = 0; split <= source.length; split++) {
                const filter = redactor.createScope().streamFilter(true)
                const output = filter(source.slice(0, split)) + filter(source.slice(split)) + filter.flush()
                assert.equal(/test-secret|PRIVATEBODY/.test(output), false, 'split ' + split)
            }
        }
    })
    await test('history flushes cannot persist half a password across separate events', async () => {
        const saved: string[] = []
        const runtime: any = { id: 'capture-test' }
        const redactor = new SecretRedactor({ knownSecrets: new Set(), config: defaults } as any)
        const capture = new AISessionCaptureMiddleware(runtime, {
            appendToContext: async (_runtime: unknown, _id: string, _type: string, data: { content: string }) => saved.push(data.content),
        } as any, redactor)
        for (const part of ['MYSQL_ROOT_PASS', 'WORD=test-', 'secret\n']) {
            capture.feedFromSession(Buffer.from(part))
            runtime.flushOutput()
        }
        capture.close()
        assert.equal(saved.join('').includes('test-secret'), false)
        assert.ok(saved.join('').includes('[REDACTED]'))
    })
}
