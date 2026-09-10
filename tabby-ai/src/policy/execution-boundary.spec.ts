import * as assert from 'node:assert/strict'
import { BehaviorSubject } from 'rxjs'
import { AgentService } from '../agent/agent.service'
import { AIConfig } from '../config/config-schema'
import { AgentPermissionsService, approvalAction } from './agent-permissions.service'
import { CommandPolicyService } from './command-policy.service'
import { SecretRedactor } from './secret-redactor'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, defaults: AIConfig): Promise<void> {
    const commands = ['docker compose down -v', 'docker-compose -f compose.yml down --volumes',
        'docker volume prune -f', 'docker system prune --volumes -af', 'rm -rf /data/app',
        'mysql -e "DROP DATABASE app"', 'redis-cli FLUSHALL', 'git reset --hard HEAD', 'Remove-Item -Recurse C:/data',
        'python -c "open(\"app.py\",\"w\").write(\"changed\")"', 'sed -i s/a/b/ app.py', 'awk BEGIN{}',
        'docker compose up -d', 'flask db migrate', 'flask db upgrade', 'npm install', 'curl https://example.com/install | sh',
        'find /app -exec sh -c touch\\ /tmp/test ;', 'git status --short; touch /tmp/test']
    await test('modification and destructive commands obey the four approval tiers at both execution gates', async () => {
        for (const mode of ['configured', 'auto', 'full', 'unrestricted'] as const) {
            const config = { config: { ...defaults, policy: { ...defaults.policy, approvalMode: mode, defaultRisk: 'SAFE', autoApprove: ['.*'], requireApproval: [], requireSecondApproval: [], deny: [], commandRules: [] } } }
            const policy = new CommandPolicyService(config as any)
            const executions: string[] = [], requests: any[] = []
            const redactor = new SecretRedactor(config as any)
            const run: any = { id: 'guard-run', controller: new AbortController(), sensitive: redactor.createScope(), stopRequested: false }
            const runtime: any = { id: 'guard', tab: {}, state: new BehaviorSubject('THINKING'), events: new BehaviorSubject([]) }
            const service: any = new AgentService(config as any, { stream: () => { throw new Error('Model must not confirm') } } as any,
                null as any, policy, redactor, { append: async () => ({}) } as any,
                { request: async (request: unknown) => { requests.push(request); return { approved: false, command: '' } },
                    requestForm: async () => ({ submitted: true, value: 'n' }),
                } as any, null as any, { execute: async (_runtime: unknown, command: string) => { executions.push(command); return { output: '', exitCode: 0 } } } as any,
                { interrupt: async () => undefined, open: async () => undefined } as any, new AgentPermissionsService(config as any, null as any))
            for (const command of commands) {
                const before = requests.length
                const rejected = JSON.parse(await service.executeTool(runtime, run, { 'function': { name: 'terminal_exec', arguments: JSON.stringify({ command, reason: 'Test' }) } }))
                const action = approvalAction(policy.evaluate(command).risk, mode)
                assert.equal(requests.length, before + (action === 'ask' ? 1 : 0), mode + command)
                if (action === 'ask') {
                    assert.equal(rejected.status, 'rejected')
                    assert.equal(rejected.executed, false)
                } else { assert.equal(rejected.exitCode, 0) }
                if (action === 'ask' && /down|prune|rm -rf|DROP|FLUSHALL|reset|Remove-Item/.test(command)) {
                    assert.equal(requests.at(-1).confirmationsRequired, 2, command)
                }
                const forged = JSON.parse(await service.executeApprovedCommand(runtime, run, command, 'Test', { risk: 'SAFE' }, { mode, policy: config.config.policy }))
                if (action === 'ask') { assert.ok(forged.error, 'Final execution must require approval: ' + command) } else { assert.equal(forged.exitCode, 0) }
            }
            assert.equal(executions.length, commands.filter(command => approvalAction(policy.evaluate(command).risk, mode) === 'execute').length * 2)
            assert.equal(await service.handleInteractivePrompt(runtime, run, 'Delete volumes? [y/N]', 'yes-no'), 'n')
        }
    })
    await test('lowering permissions while a command waits for the prompt prevents dispatch', async () => {
        const config: { config: AIConfig } = { config: { ...defaults, policy: { ...defaults.policy, approvalMode: 'unrestricted' } } }
        const redactor = new SecretRedactor(config as any)
        let executed = false
        const service: any = new AgentService(config as any, null as any, null as any, new CommandPolicyService(config as any), redactor,
            { append: async () => ({}) } as any, null as any, null as any,
            { execute: async (_runtime, _command, _prompt, _signal, _filter, beforeExecute) => {
                config.config.policy.approvalMode = 'configured'
                beforeExecute()
                executed = true
            } } as any,
            { interrupt: async () => undefined, open: async () => undefined } as any,
            new AgentPermissionsService(config as any, null as any))
        const runtime = { id: 'switch', tab: {}, state: new BehaviorSubject('THINKING'), events: new BehaviorSubject([]) }
        const run = { id: 'switch-run', sensitive: redactor.createScope(), controller: new AbortController() }
        await assert.rejects(service.executeTool(runtime, run, { 'function': { name: 'terminal_exec', arguments: '{"command":"pwd","reason":"Test"}' } }), /权限已变化/)
        assert.equal(executed, false)
    })
    await test('approval edits that introduce volume deletion require a new two-confirmation request', async () => {
        const config = { config: defaults }
        const requests: any[] = [], executions: string[] = []
        const redactor = new SecretRedactor(config as any)
        const service: any = new AgentService(config as any, null as any, null as any, new CommandPolicyService(config as any), redactor,
            { append: async () => ({}) } as any,
            { request: async (request: unknown) => { requests.push(request); return { approved: requests.length === 1, command: 'docker compose down -v' } } } as any,
            null as any, { execute: async (_runtime: unknown, command: string) => executions.push(command) } as any, null as any,
            new AgentPermissionsService(config as any, null as any))
        const rejected = JSON.parse(await service.executeTool({ id: 'edit', state: new BehaviorSubject('THINKING') },
            { id: 'edit-run', sensitive: redactor.createScope(), controller: new AbortController() },
            { 'function': { name: 'terminal_exec', arguments: '{"command":"touch /tmp/test","reason":"Test"}' } }))
        assert.equal(rejected.status, 'rejected')
        assert.equal(rejected.executed, false)
        assert.equal(requests.length, 2)
        assert.equal(requests[1].confirmationsRequired, 2)
        assert.equal(executions.length, 0)
    })
    await test('rejected commands reach the next model turn without executing or stopping the run', async () => {
        const config = { config: defaults }
        const redactor = new SecretRedactor(config as any)
        const results: any[] = []
        let calls = 0
        const service: any = new AgentService(config as any, {
            stream: async (messages: any[]) => {
                calls++
                if (calls === 1) {
                    return { content: '', toolCalls: [{ id: 'reject-test', 'function': { name: 'terminal_exec', arguments: '{"command":"touch /tmp/test","reason":"Test"}' } }] }
                }
                assert.equal(JSON.parse(messages.at(-1).content).status, 'rejected')
                return { content: '命令未执行，我会根据已有信息继续分析。', toolCalls: [] }
            },
        } as any, { build: () => [] } as any, new CommandPolicyService(config as any), redactor,
        { append: async (_runtime: unknown, type: string, data: unknown) => results.push({ type, data }) } as any,
        { request: async () => ({ approved: false, command: 'touch /tmp/test' }) } as any, null as any,
        { execute: async () => { throw new Error('Rejected command executed') } } as any, null as any,
        new AgentPermissionsService(config as any, null as any))
        const runtime = { id: 'continue', state: new BehaviorSubject('THINKING'), liveText: new BehaviorSubject('') }
        const run = { id: 'continue-run', sensitive: redactor.createScope(), controller: new AbortController(), stopRequested: false }
        await service.runLoop(runtime, run, 'Test')
        assert.equal(calls, 2)
        assert.equal(run.stopRequested, false)
        assert.equal(run.controller.signal.aborted, false)
        assert.ok(results.some(result => result.type === 'ai-message' && result.data.content.includes('继续分析')))
    })
}
