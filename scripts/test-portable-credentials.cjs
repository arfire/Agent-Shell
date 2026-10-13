/* Isolated credential regression checks. All secrets are synthetic canaries. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('../node_modules/typescript')
const rx = require('../node_modules/rxjs')
const yaml = require('../tabby-ai/node_modules/js-yaml')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, '.build-cache/credential-test-'))
const modules = new Map()
const osVault = new Map()
let osWrites = 0
let osReads = 0
const serialize = fn => {
    let pending = Promise.resolve()
    return (...args) => {
        const result = pending.then(() => fn(...args))
        pending = result.catch(() => {})
        return result
    }
}
function load(file) {
    const filename = path.resolve(root, file)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
    const localRequire = id => {
        if (require('node:module').isBuiltin(id)) return require(id)
        if (id === '@angular/core') return { Injectable: () => x => x, Component: () => x => x, ViewChild: () => () => {}, Inject: () => () => {} }
        if (id === '@ng-bootstrap/ng-bootstrap') return {}
        if (id === '@electron/remote') return { app: { getPath: () => directory } }
        if (id === 'rxjs') return rx
        if (id === 'js-yaml') return yaml
        if (id === 'keytar') return {
            getPassword: async (key, account) => { osReads++; return osVault.get(key + ':' + account) ?? null },
            setPassword: async () => { osWrites++ }, deletePassword: async () => { osWrites++ },
        }
        if (id === 'tabby-core') return {}
        if (id === 'tabby-terminal') return { SessionMiddleware: class {}, XTermFrontend: class {} }
        if (id === 'tabby-ssh') return {}
        if (id === '../utils') return { serializeFunction: serialize, wrapPromise: (_zone, value) => value }
        if (filename.includes('tabby-core')) return { FileProvider: class {} }
        if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id + '.ts'))
        return require(id)
    }
    new Function('require', 'module', 'exports', '__dirname', source)(localRequire, module, module.exports, path.dirname(filename))
    return module.exports
}
// Node builtins used by VaultService must remain real, including encryption.
const { VaultService } = load('tabby-core/src/services/vault.service.ts')
const { AIConfigService } = load('tabby-ai/src/config/ai-config.service.ts')
const { PasswordStorageService } = load('tabby-ssh/src/services/passwordStorage.service.ts')
const { ChatCompletionsClient } = load('tabby-ai/src/llm/chat-completions.client.ts')
const { AgentService } = load('tabby-ai/src/agent/agent.service.ts')
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS', name) }
function vault(stored = null) {
    const result = new VaultService({})
    result.setStore(stored)
    result.setPersistence(async () => fs.promises.writeFile(path.join(directory, 'vault.json'), JSON.stringify(result.store)))
    return result
}
async function main() {
    process.env.TABBY_DATA_DIRECTORY = directory
    const store = vault()
    const config = new AIConfigService({ create: () => ({ error: () => {} }) }, store, {})
    await config.ready
    await test('model and search credentials save and survive restart without any master password prompt', async () => {
        const settings = JSON.parse(JSON.stringify(config.config))
        settings.llm.apiKey = 'LOCAL_MODEL_SECRET_14726'
        settings.web.model.apiKey = 'LOCAL_WEB_SECRET_81572'
        settings.web.authorization = 'Bearer LOCAL_SEARCH_SECRET_74219'
        await config.save(settings)
        const disk = fs.readFileSync(config.configPath, 'utf8')
        const encrypted = fs.readFileSync(path.join(directory, 'vault.json'), 'utf8')
        for (const value of [settings.llm.apiKey, settings.web.model.apiKey, settings.web.authorization]) {
            assert.ok(!disk.includes(value) && !encrypted.includes(value))
        }
        const restarted = new AIConfigService({ create: () => ({ error: () => {} }) }, vault(JSON.parse(encrypted)), {})
        await restarted.ready
        assert.equal(await restarted.resolveSecret(restarted.config.llm.apiKey), settings.llm.apiKey)
        assert.equal(await restarted.resolveSecret(restarted.config.web.authorization), settings.web.authorization)
        assert.equal(JSON.parse(encrypted).version, 2)
        assert.match(JSON.parse(encrypted).localKey, /^[a-f0-9]{64}$/)
    })
    await test('new API key is saved as a local reference without changing its value', async () => {
        config.config.llm.apiKey = 'LOCAL_CURRENT_KEY_94281'
        await config.protectStoredCredentials()
        assert.match(config.config.llm.apiKey, /^ash-vault:/)
        assert.equal(await config.resolveSecret(config.config.llm.apiKey), 'LOCAL_CURRENT_KEY_94281')
        assert.ok(!fs.readFileSync(config.configPath, 'utf8').includes('LOCAL_CURRENT_KEY_94281'))
    })
    await test('unsupported containers do not block new credentials; stale references are cleared only in the settings draft', async () => {
        const unsupported = { version: 1, contents: 'UNSUPPORTED_DATA', keySalt: '', iv: '' }
        const isolated = vault(unsupported)
        isolated.setPersistence(() => assert.fail('No compatibility rewrite'))
        assert.equal(await isolated.load(), null)
        assert.equal(isolated.isEnabled(), false)
        await assert.rejects(isolated.decrypt(unsupported), /不支持此凭据格式/)
        const service = new AIConfigService({ create: () => ({ error: () => {} }) }, isolated, {})
        await service.ready
        const draft = JSON.parse(JSON.stringify(service.config))
        assert.equal((await service.clearUnavailableReferences(draft)).length, 3)
        assert.equal(draft.llm.apiKey, '')
        assert.match(service.config.llm.apiKey, /^ash-vault:/)
        let writes = 0
        isolated.setPersistence(async () => { writes++ })
        draft.llm.apiKey = 'LOCAL_REENTERED_KEY_21947'
        await service.save(draft)
        assert.ok(writes > 0)
        assert.equal(isolated.store.version, 2)
        assert.equal(unsupported.contents, 'UNSUPPORTED_DATA')
        assert.equal(await service.resolveSecret(service.config.llm.apiKey), draft.llm.apiKey)
        const restarted = new AIConfigService({ create: () => ({ error: () => {} }) }, vault(isolated.store), {})
        await restarted.ready
        assert.equal(await restarted.resolveSecret(restarted.config.llm.apiKey), draft.llm.apiKey)
        await config.save(config.config)
    })
    await test('damaged automatic unlock data is not replaced and does not request a password', async () => {
        const bad = { ...store.store, localKey: 'invalid' }
        const isolated = vault(bad)
        await assert.rejects(isolated.load(), /损坏/)
        assert.deepEqual(isolated.store, bad)
    })
    await test('unsupported whole-config format exits without modifying the file or asking for a password', async () => {
        const { ConfigService } = load('tabby-core/src/services/config.service.ts')
        const service = Object.create(ConfigService.prototype)
        service.vault = vault()
        let closed = false, messages = 0
        service.platform = { saveConfig: () => assert.fail('No compatibility rewrite'), quit: () => { closed = true },
            showMessageBox: async options => { messages++; assert.deepEqual(options.buttons, ['关闭程序']) } }
        const unsupported = { encrypted: true, vault: { version: 1, contents: 'UNCHANGED' } }
        await assert.rejects(service.maybeDecryptConfig(unsupported), /不再支持/)
        assert.equal(closed, true)
        assert.equal(messages, 1)
        assert.equal(unsupported.vault.contents, 'UNCHANGED')
    })
    await test('failed vault persistence cannot create a dangling config reference', async () => {
        const previous = fs.readFileSync(config.configPath, 'utf8')
        const failed = vault()
        failed.setPersistence(async () => { throw new Error('synthetic disk failure') })
        const isolated = new AIConfigService({ create: () => ({ error: () => {} }) }, failed, {})
        await isolated.ready
        await assert.rejects(isolated.save({ ...isolated.config, llm: { ...isolated.config.llm, apiKey: 'LOCAL_FAILURE_82731' } }))
        assert.equal(failed.isEnabled(), false)
        assert.equal(fs.readFileSync(config.configPath, 'utf8'), previous)
    })
    await test('whole-config encryption saves and reopens current data without prompting or recursive writes', async () => {
        const { ConfigService } = load('tabby-core/src/services/config.service.ts')
        const service = Object.create(ConfigService.prototype)
        const current = await store.encrypt({ secrets: [{ type: 'test', key: {}, value: 'SAVE_CURRENT_951' }], config: {} })
        service.vault = vault(current)
        service._store = { version: 8, encrypted: true, vault: current, profiles: [{ name: 'keep' }] }
        service.store = service._store
        service.ready = new rx.AsyncSubject(); service.ready.next(true); service.ready.complete()
        service.changed = new rx.Subject()
        let disk, writes = 0
        service.platform = { saveConfig: async text => { disk = yaml.load(text); writes++ } }
        service.save = serialize(service.save.bind(service))
        service.vault.setPersistence(async () => { service.store.vault = service.vault.store; await service.save() })
        let timer
        try {
            await Promise.race([service.save(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Recursive save deadlock')), 5000) })])
        } finally { clearTimeout(timer) }
        assert.equal(writes, 1)
        assert.equal(disk.vault.version, 2)
        assert.equal(service.vault.store.version, 2)
        await service.save()
        assert.equal((await service.vault.load()).secrets[0].value, 'SAVE_CURRENT_951')
    })
    await test('portable SSH saves, reads and deletes locally without importing or accessing system credentials', async () => {
        const service = new PasswordStorageService(store)
        const profile = { options: { host: 'test.invalid', port: 2222, user: 'demo' } }
        osVault.set('ssh@test.invalid:2222:demo', 'LOCAL_OLD_SSH_91723')
        assert.equal(await service.loadPassword(profile), null)
        await service.savePassword(profile, 'LOCAL_NEW_SSH_67129')
        assert.equal(await service.loadPassword(profile), 'LOCAL_NEW_SSH_67129')
        await service.savePrivateKeyPassword('testhash', 'LOCAL_KEY_PASS_89314')
        assert.equal(await service.loadPrivateKeyPassword('testhash'), 'LOCAL_KEY_PASS_89314')
        await service.deletePassword(profile)
        assert.equal(await service.loadPassword(profile), null)
        assert.equal(osReads, 0)
        assert.equal(osWrites, 0)
    })
    await test('concurrent credential saves retain every entry and expose only names in the picker', async () => {
        const references = await Promise.all(Array.from({ length: 6 }, (_, index) => config.saveAgentCredential('LOCAL_AGENT_' + index, 'Credential ' + index)))
        for (let i = 0; i < references.length; i++) assert.equal(await config.loadAgentCredential(references[i]), 'LOCAL_AGENT_' + i)
        assert.ok(!(JSON.stringify(await config.listAgentCredentials())).includes('LOCAL_AGENT_'))
    })
    await test('mixed vault mutations do not lose concurrent additions or updates', async () => {
        const original = { type: 'test', key: { id: 'original' }, value: 'before' }
        await store.addSecret(original)
        await Promise.all([
            store.addSecret({ type: 'test', key: { id: 'new' }, value: 'retained' }),
            store.updateSecret(original, { ...original, value: 'after' }),
            store.removeSecret('test', { id: 'missing' }),
        ])
        assert.equal((await store.getSecret('test', { id: 'new' })).value, 'retained')
        assert.equal((await store.getSecret('test', { id: 'original' })).value, 'after')
    })
    await test('SSH credentials survive restarting the local store without a password mechanism', async () => {
        const service = new PasswordStorageService(vault(JSON.parse(JSON.stringify(store.store))))
        assert.equal(await service.loadPrivateKeyPassword('testhash'), 'LOCAL_KEY_PASS_89314')
    })
    await test('request inspector matches the exact outgoing body while auth stays out of context', async () => {
        const originalFetch = global.fetch
        let packet, preview
        global.fetch = async (_url, options) => {
            packet = options
            return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        }
        try {
            const client = new ChatCompletionsClient(config)
            config.config.llm.model = 'local-test'
            await client.stream([{ role: 'user', content: 'Check LOCAL_CURRENT_KEY_94281 and __TABBY_SENSITIVE_1__' }], [], { onRequest: body => preview = body })
            assert.equal(packet.body, preview)
            assert.ok(!packet.body.includes('LOCAL_CURRENT_KEY_94281'))
            assert.equal(packet.headers.Authorization, 'Bearer LOCAL_CURRENT_KEY_94281')
            assert.ok(packet.body.includes('__TABBY_SENSITIVE_1__'))
        } finally { global.fetch = originalFetch }
    })
    await test('short and escaped secrets are masked without corrupting model protocol fields', async () => {
        const originalFetch = global.fetch
        let packet
        global.fetch = async (_url, options) => {
            packet = JSON.parse(options.body)
            return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        }
        const escaped = 'local"quoted\\secret'
        config.knownSecrets.add('user')
        config.knownSecrets.add(escaped)
        try {
            config.config.llm.model = 'user-model'
            await new ChatCompletionsClient(config).stream([
                { role: 'user', content: 'user ' + escaped },
                { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'user_tool', arguments: JSON.stringify({ password: escaped }) } }] },
            ], [{ type: 'function', function: { name: 'user_tool', parameters: {}, description: 'test' } }], {})
            assert.equal(packet.model, 'user-model')
            assert.equal(packet.messages[0].role, 'user')
            assert.equal(packet.messages[0].content, '[REDACTED] [REDACTED]')
            assert.equal(packet.messages[1].tool_calls[0].function.name, 'user_tool')
            assert.equal(JSON.parse(packet.messages[1].tool_calls[0].function.arguments).password, '[REDACTED]')
            assert.equal(packet.tools[0].function.name, 'user_tool')
        } finally {
            global.fetch = originalFetch
            config.knownSecrets.delete('user')
            config.knownSecrets.delete(escaped)
        }
    })
    await test('unrestricted generated passwords never require or write a vault', async () => {
        const agent = Object.create(AgentService.prototype)
        agent.config = config
        agent.sessions = { append: async () => {} }
        agent.permissions = { mode: () => 'unrestricted' }
        const run = { id: 'test', controller: new AbortController() }
        const result = JSON.parse(await agent.executeTool({}, run, { function: { name: 'generate_secret', arguments: JSON.stringify({ description: 'New random credential' }) } }))
        assert.equal(result.saved, false)
        assert.match(result.value, /^[a-f0-9]{64}$/)
        const saved = (await config.listAgentCredentials()).find(x => x.description === 'New random credential')
        assert.equal(saved, undefined)
    })
    console.log(count + ' portable credential checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
