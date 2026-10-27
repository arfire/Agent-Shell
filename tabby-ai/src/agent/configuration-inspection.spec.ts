import * as assert from 'node:assert/strict'
import { posix as path } from 'path'
import type { SFTPSession } from 'tabby-ssh'
import { ConfigurationDocument, configurationRevision, configurationRisk } from './configuration-document'
import { ConfigurationSession } from './configuration-inspection'
import { SecretRedactor } from '../policy/secret-redactor'
import { AIConfig } from '../config/config-schema'

const SOURCE = '# keep this comment\nservices:\n  gitea:\n    image: gitea/gitea:latest\n    ports: ["3000:3000"]\n    environment:\n      - USER_UID=1000\n      - DB_PASSWORD=fixture-private-password\n      - CUSTOM_VALUE=fixture-unknown-private\n    labels:\n      internal: fixture-private-label\n'
const FILE = '/project/compose.yml'

function memoryFiles () {
    const data = new Map<string, string>([[FILE, SOURCE]])
    const directories = new Set(['/', '/project'])
    const modes = new Map<string, number>([[FILE, 0o640]])
    const links = new Map<string, string>()
    const metadata = (file: string) => ({
        name: path.basename(file), fullPath: file, isDirectory: directories.has(file), isSymlink: links.has(file),
        mode: modes.get(file) ?? 0o700, size: Buffer.byteLength(data.get(file) ?? ''), modified: new Date(0), uid: 1000, gid: 1000,
    })
    const files: any = {
        readdir: async (directory: string) => {
            if (!directories.has(directory)) { throw new Error('No such directory') }
            return [...new Set([...data.keys(), ...directories, ...links.keys()])].filter(file => file !== directory && path.dirname(file) === directory).map(metadata)
        },
        readlink: async (file: string) => links.get(file)!,
        open: async (file: string, flags: number) => {
            if (flags & 8) { data.set(file, '') }
            let read = false
            return {
                read: async () => { const result = read ? Buffer.alloc(0) : Buffer.from(data.get(file)!); read = true; return result },
                write: async (chunk: Uint8Array) => data.set(file, (data.get(file) ?? '') + Buffer.from(chunk).toString('utf8')),
                close: async () => undefined,
            }
        },
        mkdir: async (file: string) => directories.add(file),
        chmod: async (file: string, mode: number) => modes.set(file, mode),
        rename: async (from: string, to: string) => {
            if (!data.has(from) || data.has(to)) { throw new Error('rename failed') }
            data.set(to, data.get(from)!)
            modes.set(to, modes.get(from) ?? 0o600)
            data.delete(from)
        },
        unlink: async (file: string) => data.delete(file),
        rmdir: async (file: string) => directories.delete(file),
    }
    return { files, data, directories, modes, links }
}

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>, defaults: AIConfig): Promise<void> {
    await test('YAML projection exposes deployment fields without unknown values, passwords or comments', async () => {
        const view = new ConfigurationDocument(FILE, SOURCE).view()
        const text = JSON.stringify(view)
        assert.ok(text.includes('gitea/gitea:latest') && text.includes('3000:3000') && text.includes('USER_UID=1000'))
        for (const privateValue of ['fixture-private-password', 'fixture-unknown-private', 'fixture-private-label', 'keep this comment']) { assert.ok(!text.includes(privateValue)) }
        assert.ok(text.includes('hidden') && text.includes('configured'))
    })
    await test('field patch preserves existing private values and comments and rejects sanitized round trips', async () => {
        const patch = [{ path: ['services', 'gitea', 'ports', 0], value: '3001:3000' }]
        const output = new ConfigurationDocument(FILE, SOURCE).apply(patch, () => assert.fail())
        assert.ok(output.includes('3001:3000') && output.includes('fixture-private-password') && output.includes('# keep this comment'))
        for (const value of ['[HIDDEN]', '[REDACTED]', '__TABBY_SENSITIVE_999__']) {
            assert.throws(() => new ConfigurationDocument(FILE, SOURCE).apply([{ path: ['services', 'gitea', 'image'], value }], () => { throw new Error('invalid handle') }))
        }
        assert.throws(() => new ConfigurationDocument(FILE, SOURCE).apply([{ path: ['services'], value: {} }], () => assert.fail()), /覆盖已有隐藏字段/)
        assert.equal(configurationRisk([{ path: ['services', 'gitea'], value: { privileged: true } }]), 'DANGEROUS')
        assert.equal(configurationRisk(patch), 'MODIFY')
    })
    await test('configuration passwords are bound to one file and field and never usable as terminal credentials', async () => {
        const scope = new SecretRedactor({ config: defaults, knownSecrets: new Set() } as any).createScope()
        const parts = ['services', 'gitea', 'environment', 1]
        const token = scope.registerSecret('replacement-quote\'"-$()-value', { program: 'configuration', target: FILE + '#/services/gitea/environment/1' })
        const output = new ConfigurationDocument(FILE, SOURCE).apply([{ path: parts, value: 'DB_PASSWORD=' + token }],
            (value, target) => scope.configurationValue(value, FILE, target))
        assert.ok(output.includes('replacement-quote'))
        assert.ok(!JSON.stringify(new ConfigurationDocument(FILE, output).view()).includes('replacement-quote'))
        assert.throws(() => scope.configurationValue(token, '/other/compose.yml', parts), /只能填入/)
        assert.throws(() => scope.configurationValue(token, FILE, ['image']), /只能填入/)
        assert.ok(scope.useReason('echo ' + token))
        scope.clear()
        assert.throws(() => scope.configurationValue(token, FILE, parts), /只能填入/)
    })
    await test('unrestricted config edits accept autonomous passwords while restricted edits require the form', async () => {
        const changes = [{ path: ['services', 'gitea', 'environment', 1], value: 'DB_PASSWORD=autonomous-generated-value' }]
        assert.throws(() => new ConfigurationDocument(FILE, SOURCE).apply(changes, () => assert.fail()), /密码框/)
        const output = new ConfigurationDocument(FILE, SOURCE).apply(changes, () => assert.fail(), true)
        assert.ok(output.includes('autonomous-generated-value'))
    })
    await test('dotenv and JSON keep credential values while public port fields remain editable', async () => {
        for (const [file, input] of [['/project/.env', '# original\nAPP_PORT=3000\nDB_PASSWORD=\'private-env-value\'\n'],
            ['/project/config.json', '{"server":{"port":3000},"DB_PASSWORD":"private-json-value"}']]) {
            const document = new ConfigurationDocument(file, input)
            assert.ok(!JSON.stringify(document.view()).includes('private-'))
            const output = document.apply([{ path: file.endsWith('.json') ? ['server', 'port'] : ['APP_PORT'], value: 3001 }], () => assert.fail())
            assert.ok(output.includes('3001') && output.includes('private-'))
        }
        assert.throws(() => new ConfigurationDocument(FILE, 'services: [\nprivate-parser-value'), error => !String(error).includes('private-parser-value'))
        assert.throws(() => new ConfigurationDocument(FILE, '{}').apply([{ path: ['__proto__', 'polluted'], value: true }], () => assert.fail()))
    })
    await test('YAML aliases remain valid and private fields cannot change indirectly through an anchor', async () => {
        const text = 'image: &shared gitea/gitea:latest\npassword: *shared\n'
        assert.throws(() => new ConfigurationDocument(FILE, text).apply([{ path: ['image'], value: 'gitea/gitea:next' }], () => assert.fail()), /隐藏字段/)
    })
    await test('service identifiers and Compose secret references are ordinary configuration, not password values', async () => {
        const input = 'services:\n  secret-service:\n    image: gitea/gitea:latest\n    secrets: [database-password]\n    environment:\n      DB_PASSWORD_FILE: /run/secrets/database-password\nsecrets:\n  database-password:\n    file: ./private-password.txt\n'
        const view = JSON.stringify(new ConfigurationDocument(FILE, input).view())
        assert.ok(view.includes('gitea/gitea:latest') && view.includes('/run/secrets/database-password') && view.includes('./private-password.txt'))
        const result = new ConfigurationDocument(FILE, input).apply([{ path: ['services', 'secret-service', 'image'], value: 'gitea/gitea:next' }], () => assert.fail())
        assert.ok(result.includes('gitea/gitea:next'))
    })
    await test('Gitea public ROOT_URL can be changed with its port while authenticated URLs stay hidden', async () => {
        const input = 'services:\n  gitea:\n    ports: ["3000:3000"]\n    environment:\n      GITEA__server__ROOT_URL: http://192.168.1.190:3000/\n      DB_PASSWORD: private-kept\n'
        const view = JSON.stringify(new ConfigurationDocument(FILE, input).view())
        assert.ok(view.includes('http://192.168.1.190:3000/'))
        const output = new ConfigurationDocument(FILE, input).apply([
            { path: ['services', 'gitea', 'ports', 0], value: '3001:3000' },
            { path: ['services', 'gitea', 'environment', 'GITEA__server__ROOT_URL'], value: 'http://192.168.1.190:3001/' },
        ], () => assert.fail())
        assert.ok(output.includes('3001/') && output.includes('private-kept'))
        assert.ok(!JSON.stringify(new ConfigurationDocument(FILE, 'ROOT_URL: https://user:private-value@example.com\n').view()).includes('private-value'))
    })
    await test('SFTP field update preserves a private backup and refuses stale revisions', async () => {
        const fixture = memoryFiles()
        const session = new ConfigurationSession(fixture.files, () => undefined, fixture.files.chmod)
        const view = await session.read(FILE, ['/project'])
        const result = await session.apply(FILE, view.revision as string, [{ path: ['services', 'gitea', 'ports', 0], value: '3001:3000' }], ['/project'], () => assert.fail())
        assert.equal(fixture.data.get(result.backup as string), SOURCE)
        assert.equal(fixture.modes.get(path.dirname(result.backup as string)), 0o700)
        assert.equal(fixture.modes.get(FILE), 0o640)
        assert.ok(fixture.data.get(FILE)!.includes('fixture-private-password'))
        assert.ok(!JSON.stringify(result).includes('fixture-private-password'))
        const changed = fixture.data.get(FILE)! + '# external edit\n'
        fixture.data.set(FILE, changed)
        await assert.rejects(session.apply(FILE, result.revision as string, [{ path: ['image'], value: 'other' }], ['/project'], () => assert.fail()), /其他操作修改/)
        assert.equal(fixture.data.get(FILE), changed)
    })
    await test('SFTP failed replacement restores the original and cleans only its temporary files', async () => {
        const fixture = memoryFiles()
        const session = new ConfigurationSession(fixture.files, () => undefined, fixture.files.chmod)
        const view = await session.read(FILE, ['/project'])
        const rename = fixture.files.rename
        fixture.files.rename = async (from: string, to: string) => {
            if (from.endsWith('/content')) { throw new Error('injected failure') }
            await rename(from, to)
        }
        await assert.rejects(session.apply(FILE, view.revision as string, [{ path: ['services', 'gitea', 'image'], value: 'gitea/gitea:next' }], ['/project'], () => assert.fail()), /原文件已保留/)
        assert.equal(fixture.data.get(FILE), SOURCE)
        assert.deepEqual([...fixture.data.keys()], [FILE])
    })
    await test('configuration scope rejects symlink escapes and stop prevents any replacement', async () => {
        const fixture = memoryFiles()
        fixture.links.set('/project/out.yml', '/elsewhere/config.yml')
        const session = new ConfigurationSession(fixture.files, () => undefined, fixture.files.chmod)
        await assert.rejects(session.read('/project/out.yml', ['/project']), /之外/)
        let stopped = false
        const stoppedSession = new ConfigurationSession(fixture.files, () => { if (stopped) { throw new Error('stopped') } }, fixture.files.chmod)
        const view = await stoppedSession.read(FILE, ['/project'])
        stopped = true
        await assert.rejects(stoppedSession.apply(FILE, view.revision as string, [{ path: ['image'], value: 'other' }], ['/project'], () => assert.fail()), /stopped/)
        assert.equal(fixture.data.get(FILE), SOURCE)
        session.clear()
        await assert.rejects(session.apply(FILE, configurationRevision(SOURCE), [{ path: ['image'], value: 'other' }], ['/project'], () => assert.fail()), /先读取/)
    })
    await test('a missing deployment file can be created without sending a password through a shell', async () => {
        const fixture = memoryFiles()
        const session = new ConfigurationSession(fixture.files, () => undefined, fixture.files.chmod)
        const file = '/project/new/nested/compose.yml'
        const view = await session.read(file, ['/project'])
        assert.equal(view.revision, 'missing')
        const result = await session.apply(file, 'missing', [{ path: ['services', 'gitea'], value: { image: 'gitea/gitea:latest', ports: ['3000:3000'] } }], ['/project'], () => assert.fail())
        assert.equal(result.written, true)
        assert.equal(fixture.modes.get(file), 0o600)
    })
}

export async function runRemoteTests (
    test: (name: string, run: () => Promise<void>) => Promise<void>,
    files: SFTPSession, permissions: (file: string, mode: number) => Promise<void>,
): Promise<void> {
    const directory = '/tmp/ash-configuration-' + Date.now()
    await files.mkdir(directory)
    const file = directory + '/compose.yml'
    const handle = await files.open(file, 2 | 8 | 16)
    await handle.write(Buffer.from(SOURCE))
    await handle.close()
    const session = new ConfigurationSession(files, () => undefined, permissions)
    await test('real SFTP YAML read/patch retains hidden credentials and a recoverable backup', async () => {
        const view = await session.read(file, [directory])
        assert.ok(!JSON.stringify(view).includes('fixture-private-password'))
        const result = await session.apply(file, view.revision as string, [{ path: ['services', 'gitea', 'ports', 0], value: '3001:3000' }], [directory], () => assert.fail())
        const original = await files.open(result.backup as string, 1)
        try { assert.equal(Buffer.from(await original.read()).toString('utf8'), SOURCE) } finally { await original.close() }
        const updated = await files.open(file, 1)
        try {
            const text = Buffer.from(await updated.read()).toString('utf8')
            assert.ok(text.includes('3001:3000') && text.includes('fixture-private-password') && text.includes('# keep this comment'))
        } finally { await updated.close() }
        assert.ok(!JSON.stringify(result).includes('fixture-private-password'))
    })
}
