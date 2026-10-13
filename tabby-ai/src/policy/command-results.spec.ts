import * as assert from 'node:assert/strict'
import { BehaviorSubject } from 'rxjs'
import { AgentService } from '../agent/agent.service'
import { AgentInteractionService } from '../agent/interaction.service'
import { AgentContextBuilder } from '../agent/context-builder'
import { AIConfig } from '../config/config-schema'
import { AgentPermissionsService } from './agent-permissions.service'
import { CommandPolicyService } from './command-policy.service'
import { SecretRedactor } from './secret-redactor'
import { commandRiskDescription } from './command-description'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, defaults: AIConfig): Promise<void> {
    const create = (mode = 'configured', output = 'UNKNOWN_SECRET_483719') => {
        const config: any = { config: { ...defaults, policy: { ...defaults.policy, approvalMode: mode } }, knownSecrets: new Set<string>() }
        const redactor = new SecretRedactor(config)
        const interactions = new AgentInteractionService()
        const events: any[] = []
        const session = {}
        const runtime: any = { id: 'disclosure', connectionId: 'connection', activeRunId: 'run', tab: { session,
            profile: { name: 'test', options: { host: 'localhost', user: 'test' } } },
        events: new BehaviorSubject(events), state: new BehaviorSubject('EXECUTING'), liveText: new BehaviorSubject('') }
        const run: any = { id: 'run', session, controller: new AbortController(), stopRequested: false,
            sensitive: redactor.createScope(() => config.config.policy.approvalMode === 'unrestricted') }
        const service: any = new AgentService(config, null as any, null as any, new CommandPolicyService(config), redactor,
            { append: async (_runtime: unknown, type: string, data: unknown) => { events.push({ type, data, seq: events.length }); return {} } } as any,
            interactions, null as any, { execute: async () => ({ exitCode: 0, output }), isExecuting: () => true } as any,
            { interrupt: async () => undefined, open: async () => undefined } as any, new AgentPermissionsService(config, null as any))
        const execute = (command = 'cat /tmp/value.txt') => service.executeApprovedCommand(runtime, run, command, 'Test',
            new CommandPolicyService(config).evaluate(command), { mode, policy: config.config.policy }, command)
        return { config, redactor, interactions, events, runtime, run, service, execute }
    }
    await test('command results return automatically in every tier without an output form', async () => {
        for (const mode of ['configured', 'auto', 'full', 'unrestricted']) {
            const f = create(mode, 'EXIT: 100\n')
            const result = JSON.parse(await f.execute('bash /tmp/install.sh'))
            assert.equal(result.output, 'EXIT: 100\n')
            assert.equal(f.interactions.forms.value.length, 0)
        }
    })
    await test('stopping releases the terminal lock immediately and records interrupted command state', async () => {
        const f = create()
        f.runtime.locked = true
        f.service.activeRuns.set(f.runtime.id, f.run)
        f.service.stop(f.runtime)
        assert.equal(f.runtime.locked, false)
        assert.equal(f.run.controller.signal.aborted, true)
        assert.equal(f.run.interruptedExecution, true)
    })
    await test('automatic command results still redact known credentials in restricted modes', async () => {
        const f = create('full', 'Password: private-value\n')
        const result = JSON.parse(await f.execute())
        assert.ok(!result.output.includes('private-value'))
        assert.ok(result.output.includes('[REDACTED]'))
        assert.equal(f.interactions.forms.value.length, 0)
        assert.equal(f.events.find(event => event.type === 'model-output').data.content, result.output)
    })
    await test('raw terminal history cannot bypass review on later turns or after reload', async () => {
        const fixture = create()
        fixture.runtime.events.next(JSON.parse(JSON.stringify([
            { type: 'ssh-output', data: { content: 'UNKNOWN_SECRET_483719', source: 'ai' } },
            { type: 'ssh-output', data: { content: 'MANUAL_SHELL_SECRET' } },
            { type: 'ssh-input', data: { content: 'echo INLINE_SECRET', source: 'user' } },
            { type: 'summary', data: { content: 'OLD_SUMMARY_SECRET' } },
            { type: 'ai-message', data: { content: 'UNRESTRICTED_REPLY_SECRET', localOnly: true } },
            { type: 'ai-command', data: { command: 'echo UNRESTRICTED_COMMAND_SECRET', permissionMode: 'unrestricted' } },
            { type: 'approval', data: { finalCommand: 'echo USER_EDITED_SECRET' } },
            { type: 'model-output', data: { content: 'Protected result', exitCode: 0 } },
        ])))
        const builder = new AgentContextBuilder(fixture.redactor, fixture.config)
        const context = JSON.stringify(builder.build(fixture.runtime, 'Continue', 8000))
        for (const secret of ['UNKNOWN_SECRET', 'MANUAL_SHELL_SECRET', 'INLINE_SECRET', 'OLD_SUMMARY_SECRET', 'UNRESTRICTED_REPLY_SECRET', 'UNRESTRICTED_COMMAND_SECRET', 'USER_EDITED_SECRET']) { assert.ok(!context.includes(secret)) }
        assert.ok(context.includes('Protected result'))
        assert.ok(JSON.stringify(builder.build(fixture.runtime, 'Continue', 8000, text => text, true)).includes('UNKNOWN_SECRET'))
    })
    await test('policy feedback reaches the model and skips dependent batch commands without ending the task', async () => {
        const fixture = create()
        let calls = 0
        fixture.service.context = { build: () => [] }
        fixture.service.client = { stream: async (messages) => {
            calls++
            if (calls === 2) {
                const feedback = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
                assert.equal(feedback.length, 2)
                assert.equal(feedback[0].executed, false)
                assert.match(feedback[0].error, /凭证保护/)
                assert.equal(feedback[0].command, 'cat .env')
                assert.match(feedback[0].next, /request_user_input/)
                assert.equal(feedback[1].executed, false)
                return { content: '请提供本次操作所需密码，或选择不依赖凭据的步骤。', toolCalls: [] }
            }
            return { content: '', toolCalls: ['cat .env', 'touch /tmp/should-not-run'].map((command, index) => ({ id: String(index),
                'function': { name: 'terminal_exec', arguments: JSON.stringify({ command, reason: 'Test' }) } })) }
        } }
        await fixture.service.runLoop(fixture.runtime, fixture.run, 'Test')
        assert.equal(calls, 2)
        assert.equal(fixture.events.some(event => event.type === 'ai-command'), false)
        assert.equal(fixture.events.find(event => event.type === 'error').data.command, 'cat .env')
    })
    await test('a bound password form resumes the task and a rejected wrapper is corrected without using the vault', async () => {
        const f = create('full', 'INSTALL_OK')
        const password = 'test-quote\'"-$()-value'
        let calls = 0
        let token = ''
        const acceptedCommand = (): string => `curl --disable --noproxy "*" -H "Authorization: Bearer ${token}" https://service.example/install`
        const sent: string[] = []
        f.config.saveAgentCredential = () => assert.fail('No business password may be saved')
        f.config.loadAgentCredential = () => assert.fail('No business password may require vault unlock')
        f.service.context = { build: () => [] }
        f.service.interactions = { requestForm: async () => ({ submitted: true, value: password }) }
        f.service.terminal = { execute: async (_runtime, command) => { sent.push(command); return { exitCode: 0, output: 'INSTALL_OK' } } }
        const tool = (name, args) => ({ id: String(calls), 'function': { name, arguments: JSON.stringify(args) } })
        f.service.client = { stream: async (messages) => {
            calls++
            assert.ok(!JSON.stringify(messages).includes(password))
            if (calls === 1) { return { content: '', toolCalls: [tool('request_user_input', { prompt: '提供服务凭据', kind: 'secret', program: 'curl', target: 'https://service.example' })] } }
            if (calls === 2) {
                token = JSON.parse(messages.at(-1).content).value
                assert.match(token, /^__TABBY_SENSITIVE_\d+__$/)
                return { content: '', toolCalls: [tool('terminal_exec', { command: `bash -c "installer --password ${token}"`, reason: 'Install' })] }
            }
            if (calls === 3) {
                assert.equal(JSON.parse(messages.at(-1).content).executed, false)
                assert.equal(JSON.parse(messages.at(-1).content).command, `bash -c "installer --password ${token}"`)
                return { content: '', toolCalls: [tool('terminal_exec', { command: acceptedCommand(), reason: 'Install' })] }
            }
            assert.equal(JSON.parse(messages.at(-1).content).exitCode, 0)
            return { content: '安装完成', toolCalls: [] }
        } }
        await f.service.runLoop(f.runtime, f.run, 'Install')
        assert.equal(calls, 4)
        assert.equal(sent.length, 1)
        assert.equal(sent[0], f.run.sensitive.restoreCommand(acceptedCommand()))
        assert.ok(!JSON.stringify(f.events).includes(password))
        f.run.sensitive.clear()
        assert.throws(() => f.run.sensitive.restoreCommand(token), /失效/)
    })
    await test('unrestricted execution bypasses task checks, credential reads, destination binding and output filtering', async () => {
        const f = create('unrestricted', 'PASSWORD=synthetic-unrestricted-value\n')
        f.run.goal = '只分析，不执行任何命令，不使用任何工具'
        const tool = (name: string, args: unknown): any => ({ 'function': { name, arguments: JSON.stringify(args) } })
        const result = JSON.parse(await f.service.executeTool(f.runtime, f.run, tool('terminal_exec', { command: 'cat /tmp/.env', reason: 'Test' })))
        assert.equal(result.output, 'PASSWORD=synthetic-unrestricted-value\n')
        f.service.interactions = { requestForm: async () => ({ submitted: true, value: 'synthetic-form-value' }) }
        const form = JSON.parse(await f.service.executeTool(f.runtime, f.run, tool('request_user_input', { kind: 'secret', prompt: 'Test' })))
        assert.match(form.value, /^__TABBY_SENSITIVE_\d+__$/)
        const token = f.run.sensitive.registerSecret('synthetic-bound-value', { program: 'curl', target: 'https://approved.example' })
        const forwarded = JSON.parse(await f.service.executeTool(f.runtime, f.run, tool('terminal_exec', { command: `echo ${token} > /tmp/test`, reason: 'Test' })))
        assert.equal(forwarded.exitCode, 0)
        assert.equal(f.interactions.forms.value.length, 0)
    })
    await test('unrestricted password generation is autonomous and never writes to the vault', async () => {
        const f = create('unrestricted')
        f.config.saveAgentCredential = () => assert.fail('Must not save generated passwords')
        const result = JSON.parse(await f.service.executeTool(f.runtime, f.run, { 'function': { name: 'generate_secret', arguments: '{}' } }))
        assert.match(result.value, /^[a-f0-9]{64}$/)
        assert.equal(result.saved, false)
        assert.equal(f.run.containsSensitiveContext, true)
        assert.equal(f.interactions.forms.value.length, 0)
        f.config.config.policy.approvalMode = 'full'
        assert.match(JSON.parse(await f.service.executeTool(f.runtime, f.run, { 'function': { name: 'generate_secret', arguments: '{}' } })).error, /request_user_input/)
    })
    await test('feedback identifies the rejected edited command and masks its actual password', async () => {
        const f = create('configured')
        const password = 'LOCAL_PRIVATE_673819'
        const placeholder = f.run.sensitive.register(password)
        const edited = `bash -c "installer --password ${password}"`
        f.service.context = { build: () => [] }
        f.service.interactions = { request: async () => ({ approved: true, command: edited }) }
        f.service.terminal = { execute: () => assert.fail('Rejected command must not execute') }
        let calls = 0
        f.service.client = { stream: async messages => {
            if (++calls === 1) {
                return { content: '', toolCalls: [{ id: 'edited', 'function': { name: 'terminal_exec',
                    arguments: JSON.stringify({ command: 'touch /tmp/approval-test', reason: 'Test' }) } }] }
            }
            const result = JSON.parse(messages.at(-1).content)
            assert.equal(result.executed, false)
            assert.equal(result.command, `bash -c "installer --password ${placeholder}"`)
            assert.match(result.error, /修改后的命令/)
            assert.ok(!JSON.stringify(messages).includes(password))
            return { content: '已了解阻止原因', toolCalls: [] }
        } }
        await f.service.runLoop(f.runtime, f.run, 'Test')
        assert.equal(calls, 2)
        assert.ok(!JSON.stringify(f.events).includes(password))
        assert.equal(f.events.find(event => event.type === 'error').data.command, edited.replace(password, placeholder))
    })
    await test('unrestricted model replies and interrupted text remain local after lowering permissions', async () => {
        const fixture = create('unrestricted')
        fixture.service.context = { build: () => [] }
        fixture.service.client = { stream: async () => ({ content: 'RAW_REPLY', toolCalls: [] }) }
        await fixture.service.runLoop(fixture.runtime, fixture.run, 'Test')
        assert.equal(fixture.events.find(event => event.type === 'ai-message').data.localOnly, true)
        fixture.run.containsSensitiveContext = true
        fixture.config.config.policy.approvalMode = 'configured'
        fixture.runtime.liveText.next('PARTIAL_RAW_REPLY')
        await fixture.service.preserveLiveText(fixture.runtime, fixture.run)
        assert.equal(fixture.events.at(-1).data.localOnly, true)
    })
    await test('risk descriptions distinguish discarded output from file overwrite and simple checks', async () => {
        assert.equal(commandRiskDescription('docker logs gitlab 2>&1 | tail -10', 'MODIFY'), '')
        assert.equal(commandRiskDescription('docker logs gitlab 1>&2', 'MODIFY'), '')
        assert.match(commandRiskDescription('docker exec gitlab cat /etc/gitlab/initial_root_password', 'DENY', true), /放手一搏模式放行/)
        assert.equal(commandRiskDescription('ls 2>/dev/null', 'MODIFY'), '')
        assert.equal(commandRiskDescription('test -n value && echo CHECK_OK', 'MODIFY'), '')
        assert.match(commandRiskDescription('echo text > /tmp/data', 'MODIFY'), /覆盖/)
        assert.match(commandRiskDescription('rm /tmp/data', 'DANGEROUS'), /删除/)
        assert.match(commandRiskDescription('systemctl restart app', 'MODIFY'), /中断/)
    })
    await test('quoted password search patterns do not redact surrounding shell syntax', async () => {
        const f = create()
        const command = 'grep "Password:" || echo "GitLab still initializing"'
        assert.equal(f.redactor.redact(command), command)
        assert.ok(!f.redactor.redact('"Password": "actual-secret"').includes('actual-secret'))
        assert.ok(!f.redactor.redact('Password: actual-secret').includes('actual-secret'))
    })
}
