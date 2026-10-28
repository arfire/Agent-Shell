import { posix as path } from 'path'
import { randomUUID } from 'crypto'
import type { SFTPSession, SFTPFile } from 'tabby-ssh'
import { ConfigurationChange, ConfigurationDocument, ConfigurationError, configurationRevision } from './configuration-document'

export const CONFIGURATION_TOOL = {
    type: 'function' as const,
    'function': {
        name: 'configuration_file',
        description: 'Read or edit project YAML, JSON or dotenv through SSH SFTP. Read returns public fields, hidden-field presence and a revision. Apply ONLY changed fields with that revision. Read first, including before creating a missing file. In restricted modes preserve hidden fields and use request_user_input(program="configuration", target="ABSOLUTE_FILE#/JSON/pointer") to change a secret. Unrestricted mode accepts generated/raw secret values directly. Never write hidden markers or resend the whole sanitized document. Paths must be in the task project or current remote directory. Compose validation/startup remain terminal_exec commands.',
        parameters: {
            type: 'object',
            properties: {
                operation: { type: 'string', 'enum': ['read', 'apply'] },
                path: { type: 'string', description: 'Absolute project configuration path.' },
                revision: { type: 'string', description: 'Exact revision from read; "missing" for a new file.' },
                changes: {
                    type: 'array', maxItems: 64,
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
                            value: { description: 'New field value, or a locally supplied secret placeholder. Leave unchanged hidden fields out.' },
                        },
                        required: ['path', 'value'], additionalProperties: false,
                    },
                },
            },
            required: ['operation', 'path'], additionalProperties: false,
        },
    },
}

export function projectPaths (input: string): string[] {
    const quoted = [...input.matchAll(/["'](\/[^"'\r\n]{1,1024})["']/g)]
    const exact = input.trim()
    if (/^\/[\p{L}\p{N}_. /-]+$/u.test(exact)) { return [path.normalize(exact)] }
    const values = quoted.map(match => match[1])
    for (const match of input.matchAll(/(?<![:/\p{L}\p{N}])\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+/gu)) {
        if (!quoted.some(q => match.index! >= q.index! && match.index! < q.index! + q[0].length)) { values.push(match[0]) }
    }
    return [...new Set(values.filter(p => !p.split('/').includes('..') && !/[\x00-\x1f\x60$]/.test(p)).map(p => path.normalize(p)))]
}

const CONFIGURATION_FILE = /(?:\/\.env(?:\.[\w-]+)?|\.(?:env|json|ya?ml))$/i

export function configurationRoots (file: unknown, goal: string, additional: string[] = []): string[] {
    if (typeof file !== 'string' || !file.startsWith('/') || !CONFIGURATION_FILE.test(file) ||
        file.split('/').includes('..') || /[\x00-\x1f\x60$]/.test(file) ||
        /\/\.(?:ssh|aws|azure|kube|docker|gnupg|ash-config[^/]*)(?:\/|$)/.test(file)) { return [] }
    const normalized = path.normalize(file)
    return [...projectPaths(goal), ...additional.filter(root => root !== '/')].flatMap(root => {
        if (CONFIGURATION_FILE.test(root)) { return normalized === root ? [path.dirname(root)] : [] }
        return normalized.startsWith(root.replace(/\/$/, '') + '/') ? [root] : []
    })
}

interface ConfigurationFiles {
    readdir: SFTPSession['readdir']
    readlink: SFTPSession['readlink']
    open: SFTPSession['open']
    mkdir: SFTPSession['mkdir']
    rename: SFTPSession['rename']
    unlink: SFTPSession['unlink']
    rmdir: SFTPSession['rmdir']
}

export class ConfigurationSession {
    private revisions = new Map<string, { token: string, hash: string }>()

    constructor (
        private files: ConfigurationFiles, private check: () => void,
        private permissions: (file: string, mode: number) => Promise<void>,
        private remember?: (value: string) => void,
        private unrestricted = false,
    ) { }

    private async canonical (file: string, depth = 0): Promise<string> {
        if (depth > 16) { throw new ConfigurationError('配置路径的符号链接过多。') }
        const parts = path.resolve('/', file).split('/').filter(Boolean)
        let parent = '/'
        for (let index = 0; index < parts.length; index++) {
            this.check()
            const entry = (await this.files.readdir(parent)).find(item => item.name === parts[index])
            if (!entry) { return path.join(parent, ...parts.slice(index)) }
            const next = path.join(parent, parts[index])
            if (entry.isSymlink) {
                return this.canonical(path.resolve(parent, await this.files.readlink(next), ...parts.slice(index + 1)), depth + 1)
            }
            if (index < parts.length - 1 && !entry.isDirectory) { throw new ConfigurationError('配置父路径不是目录。') }
            parent = next
        }
        return parent
    }

    private async destination (file: string, roots: string[]): Promise<string> {
        if (!roots.length) { throw new ConfigurationError('配置路径必须在本次项目目录或当前 SSH 工作目录内。') }
        const resolved = await this.canonical(file)
        const canonicalRoots = await Promise.all(roots.map(root => this.canonical(root)))
        if (!canonicalRoots.some(root => resolved.startsWith(root.replace(/\/$/, '') + '/'))) { throw new ConfigurationError('配置符号链接指向了项目目录之外。') }
        return resolved
    }

    private async readSource (file: string): Promise<string|null> {
        let parent = '/'
        let entry: SFTPFile|undefined = undefined
        const parts = file.split('/').filter(Boolean)
        for (let index = 0; index < parts.length; index++) {
            this.check()
            entry = (await this.files.readdir(parent)).find(item => item.name === parts[index])
            if (!entry) { return null }
            if (entry.isSymlink || index < parts.length - 1 && !entry.isDirectory) { throw new ConfigurationError('配置路径不是普通文件路径。') }
            parent = path.join(parent, parts[index])
        }
        if (!entry) { return null }
        if (entry.isDirectory || entry.isSymlink || entry.size > 1048576) { throw new ConfigurationError('配置必须是 1 MiB 以内的普通文件。') }
        const handle = await this.files.open(file, 1)
        try {
            const chunks: Buffer[] = []
            let length = 0
            while (true) {
                this.check()
                const chunk = await handle.read()
                if (!chunk.length) { break }
                length += chunk.length
                if (length > 1048576) { throw new ConfigurationError('配置文件超过 1 MiB。') }
                chunks.push(Buffer.from(chunk))
            }
            const data = Buffer.concat(chunks)
            const text = data.toString('utf8')
            if (!Buffer.from(text).equals(data)) { throw new ConfigurationError('配置文件需要使用 UTF-8 编码。') }
            return text
        } finally { await handle.close() }
    }

    async read (file: string, roots: string[]): Promise<Record<string, unknown>> {
        const resolved = await this.destination(file, roots)
        const source = await this.readSource(resolved)
        const result = new ConfigurationDocument(file, source).view(this.remember)
        this.check()
        const token = source === null ? 'missing' : randomUUID()
        this.revisions.set(resolved, { token, hash: configurationRevision(source) })
        return { ...result, revision: token }
    }

    async apply (
        file: string, revision: string, changes: ConfigurationChange[], roots: string[],
        resolve: (value: string, parts: (string|number)[]) => string,
    ): Promise<Record<string, unknown>> {
        const resolved = await this.destination(file, roots)
        const previous = this.revisions.get(resolved)
        if (!previous || previous.token !== revision) { throw new ConfigurationError('请先读取当前配置，再使用返回的 revision 修改。') }
        const original = await this.readSource(resolved)
        if (configurationRevision(original) !== previous.hash) { throw new ConfigurationError('配置已被其他操作修改，请重新读取后再应用字段修改。') }
        const rendered = new ConfigurationDocument(file, original).apply(changes, resolve, this.unrestricted)
        const parent = path.dirname(resolved)
        let current = '/'
        for (const part of parent.split('/').filter(Boolean)) {
            const entries = await this.files.readdir(current)
            const next = path.join(current, part)
            if (!entries.some(item => item.name === part)) { this.check(); await this.files.mkdir(next); await this.permissions(next, 0o700) }
            current = next
        }
        const stage = path.join(parent, '.ash-config-' + randomUUID())
        this.check()
        await this.files.mkdir(stage)
        let saved = false
        let committed = false
        const temporary = path.join(stage, 'content')
        const backup = path.join(stage, 'previous')
        try {
            await this.permissions(stage, 0o700)
            const handle = await this.files.open(temporary, 2 | 8 | 16)
            try {
                await this.permissions(temporary, 0o600)
                const data = Buffer.from(rendered)
                for (let offset = 0; offset < data.length; offset += 65536) {
                    this.check()
                    await handle.write(data.subarray(offset, offset + 65536))
                }
            } finally { await handle.close() }
            if (await this.destination(file, roots) !== resolved || configurationRevision(await this.readSource(resolved)) !== previous.hash) { throw new ConfigurationError('写入前配置或路径已变化，请重新读取。') }
            if (original !== null) {
                // Directory entries retain native metadata that russh.stat currently drops.
                const originalMetadata = (await this.files.readdir(parent)).find(item => item.name === path.basename(resolved))
                const newMetadata = (await this.files.readdir(stage)).find(item => item.name === 'content')
                if (!originalMetadata || !newMetadata || !(originalMetadata.mode & 0o777)) { throw new ConfigurationError('配置原权限无法确认，原文件未修改。') }
                if (originalMetadata.uid !== newMetadata.uid || originalMetadata.gid !== newMetadata.gid) { throw new ConfigurationError('配置文件属于其他账号或组，无法保留所有权，原文件未修改。') }
                await this.permissions(temporary, originalMetadata.mode & 0o777)
            }
            this.check()
            if (original !== null) { await this.files.rename(resolved, backup); saved = true }
            try {
                this.check()
                await this.files.rename(temporary, resolved)
                committed = true
            } catch {
                if (saved) { await this.files.rename(backup, resolved); saved = false }
                throw new ConfigurationError('配置替换未完成，原文件已保留。')
            }
            const token = randomUUID()
            this.revisions.set(resolved, { token, hash: configurationRevision(rendered) })
            return {
                ...new ConfigurationDocument(file, rendered).view(this.remember),
                revision: token,
                written: true,
                ...saved ? { backup } : {},
                validation: '配置语法已通过；Compose 配置请继续执行 config --quiet，再启动并检查状态。',
            }
        } finally {
            await this.files.unlink(temporary).catch(() => undefined)
            // A successful update retains the original as a private, recoverable backup.
            if (!saved) { await this.files.rmdir(stage).catch(() => undefined) }
            if (!committed) { this.revisions.delete(resolved) }
        }
    }

    clear (): void { this.revisions.clear() }
}

export function configurationModeCommand (file: string, mode: number, shell: string): string {
    if (!file.startsWith('/') || /[\x00-\x1f]/.test(file) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) { throw new ConfigurationError('配置权限参数无效。') }
    const escaped = shell === 'powershell' ? file.replace(/'/g, '\'\'')
        : shell === 'fish' ? file.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') : file.replace(/'/g, '\'\\\'\'')
    return 'chmod ' + mode.toString(8) + ' -- \'' + escaped + '\''
}
