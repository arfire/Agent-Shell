import { createHash } from 'crypto'
import { Document, parseDocument } from 'yaml'

export class ConfigurationError extends Error { }

export interface ConfigurationChange { path: (string|number)[], value: unknown }

const SECRET = /password|passwd|(?:^|[_-])pwd|token|secret|credential|private[_-]?key|api[_-]?key|authorization|connection[_-]?string/i
const PUBLIC = /^(?:image|ports?|target|published|protocol|restart|container_name|version|name|enabled|debug|driver|type|host_port|container_port|user_uid|user_gid|uid|gid|tz|timezone|http_port|ssh_port|app_port|server_port|app_debug|database_type|db_type|log_level)$/i
const SECRET_VALUE = /-----BEGIN .*PRIVATE KEY-----|(?:https?|ssh|mysql|postgres(?:ql)?):\/\/[^/\s]*:[^/\s]*@|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/i
const MARKER = /\[REDACTED[^\]]*\]|\[HIDDEN\]|__TABBY_SENSITIVE_\d+__/

export function configurationRevision (text: string|null): string {
    return text === null ? 'missing' : createHash('sha256').update(text).digest('hex')
}

export function validConfigurationPath (value: unknown): value is (string|number)[] {
    return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(part =>
        typeof part === 'string' && !!part && part.length <= 128 && !/[\x00-\x1f]/.test(part) &&
        !['__proto__', 'constructor', 'prototype'].includes(part) || Number.isInteger(part) && Number(part) >= 0 && Number(part) < 10000)
}

export function configurationPointer (parts: (string|number)[]): string {
    return '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
}

function fieldName (parts: (string|number)[], value: unknown): string {
    if (parts.includes('environment') && typeof value === 'string' && /^[A-Za-z_][\w]*=/.test(value)) { return value.slice(0, value.indexOf('=')) }
    return String(parts.at(-1) ?? '')
}

function configurationReference (parts: (string|number)[], value: unknown): boolean {
    const last = String(parts.at(-1))
    const scalar = typeof value === 'string' && parts.includes('environment') && /^[A-Za-z_]\w*=/.test(value)
        ? value.slice(value.indexOf('=') + 1) : value
    if (/_FILE$|_PATH$/i.test(fieldName(parts, value)) && typeof scalar === 'string' && /^(?:\/|\.\/)/.test(scalar)) { return true }
    if (parts[0] === 'secrets' && parts.length === 3 && ['file', 'environment', 'external', 'name'].includes(last)) { return true }
    return parts[0] === 'services' && parts[2] === 'secrets' &&
        (parts.length === 4 && typeof parts[3] === 'number' || parts.length === 5 && ['source', 'target', 'uid', 'gid', 'mode'].includes(last))
}

function secretField (parts: (string|number)[], value: unknown): boolean {
    if (typeof value === 'string' && SECRET_VALUE.test(value)) { return true }
    if (configurationReference(parts, value)) { return false }
    // Service names are identifiers, not credential field names.
    return parts.some((part, index) => parts[index - 1] !== 'services' && SECRET.test(String(part))) || SECRET.test(fieldName(parts, value))
}

function publicField (parts: (string|number)[], value: unknown): boolean {
    if (secretField(parts, value)) { return false }
    if (configurationReference(parts, value)) { return true }
    const field = fieldName(parts, value).replace(/^GITEA__[^_]+__/, '')
    const scalar = typeof value === 'string' && parts.includes('environment') && /^[A-Za-z_]\w*=/.test(value)
        ? value.slice(value.indexOf('=') + 1) : value
    const inherited = typeof parts.at(-1) === 'number' && parts.at(-2) !== 'environment' ? String(parts.at(-2)) : field
    if (/^(?:root_url|public_url|base_url)$/i.test(field)) {
        try {
            const url = new URL(String(scalar))
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
        } catch { return false }
    }
    if (/port|target|published/i.test(inherited)) {
        return /^(?:(?:\[[0-9a-f:]+\]|(?:[0-9]{1,3}\.){3}[0-9]{1,3}):)?[0-9]{1,5}(?:-[0-9]{1,5})?(?::[0-9]{1,5}(?:-[0-9]{1,5})?)?(?:\/(?:tcp|udp|sctp))?$/i.test(String(scalar))
    }
    if (/^(?:enabled|debug|app_debug)$/i.test(field)) { return /^(?:true|false|0|1)$/i.test(String(scalar)) }
    if (/^(?:user_uid|user_gid|uid|gid|http_port|ssh_port|app_port|server_port)$/i.test(field)) { return /^[0-9]{1,10}$/.test(String(scalar)) }
    if (parts.some(part => ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'engines'].includes(String(part)))) { return true }
    if (PUBLIC.test(field)) { return true }
    // Sequence members inherit the public schema of their containing field.
    if (typeof parts.at(-1) === 'number' && parts.at(-2) !== 'environment' && PUBLIC.test(String(parts.at(-2)))) { return true }
    return false
}

function leaves (value: unknown, visit: (parts: (string|number)[], value: unknown) => void, parts: (string|number)[] = []): void {
    if (parts.length > 32) { throw new ConfigurationError('配置嵌套过深。') }
    if (Array.isArray(value) && value.length) { value.forEach((item, index) => leaves(item, visit, [...parts, index])); return }
    if (value && typeof value === 'object' && Object.keys(value).length) {
        for (const [key, item] of Object.entries(value)) { leaves(item, visit, [...parts, key]) }
        return
    }
    visit(parts, value)
}

function getValue (value: unknown, parts: (string|number)[]): unknown {
    for (const part of parts) {
        if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) { return undefined }
        value = (value as Record<string, unknown>)[part]
    }
    return value
}

function decodeEnvValue (value: string): string {
    const trimmed = value.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try { return JSON.parse(trimmed) } catch { throw new ConfigurationError('环境变量引用格式无效。') }
    }
    if (trimmed.startsWith('\'') && trimmed.endsWith('\'')) { return trimmed.slice(1, -1).replace(/\\'/g, '\'') }
    return trimmed.replace(/\s+#.*$/, '')
}

export class ConfigurationDocument {
    private document: Document
    private envLines?: string[]
    private envRanges = new Map<string, [number, number]>()
    readonly format: 'yaml'|'json'|'env'

    constructor (public readonly file: string, private source: string|null) {
        this.format = /(?:^|\/)\.env(?:\.[\w-]+)?$|\.env$/i.test(file) ? 'env' : /\.json$/i.test(file) ? 'json' : 'yaml'
        try {
            if (this.format === 'env') {
                this.envLines = (source ?? '').split(/\r?\n/)
                const values: Record<string, string> = Object.create(null)
                for (let index = 0; index < this.envLines.length; index++) {
                    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)$/.exec(this.envLines[index])
                    if (!match) { continue }
                    let value = match[2].trim()
                    const start = index
                    if (/^['"]/.test(value)) {
                        const quote = value[0]
                        const closing = new RegExp('(?<!\\\\)' + quote + '\\s*$')
                        while (!closing.test(value.slice(1)) && ++index < this.envLines.length) { value += '\n' + this.envLines[index] }
                        if (index >= this.envLines.length) { throw new ConfigurationError() }
                    }
                    if (Object.prototype.hasOwnProperty.call(values, match[1])) { throw new ConfigurationError() }
                    values[match[1]] = decodeEnvValue(value)
                    this.envRanges.set(match[1], [start, index])
                }
                this.document = new Document(values)
            } else if (this.format === 'json') {
                this.document = new Document(source === null ? {} : JSON.parse(source))
            } else {
                this.document = parseDocument(source ?? '{}\n', { prettyErrors: false, keepSourceTokens: true, uniqueKeys: true, merge: true, logLevel: 'silent' })
                if (this.document.errors.length || this.document.warnings.length) { throw new ConfigurationError() }
            }
            const value = this.value()
            if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new ConfigurationError() }
        } catch {
            throw new ConfigurationError('配置格式无效；错误原文未外发。请检查 YAML、JSON 或环境变量格式。')
        }
    }

    private value (): unknown {
        return this.document.toJS({ maxAliasCount: 50 })
    }

    view (remember?: (value: string) => void): Record<string, unknown> {
        const fields: Record<string, unknown>[] = []
        leaves(this.value(), (parts, value) => {
            if (!parts.length) { return }
            if (fields.length >= 1024) { throw new ConfigurationError('配置字段过多，请拆分配置文件。') }
            const visible = publicField(parts, value)
            if (!visible && secretField(parts, value) && typeof value === 'string') {
                const secret = parts.includes('environment') && /^[A-Za-z_]\w*=/.test(value) ? value.slice(value.indexOf('=') + 1) : value
                if (secret.length >= 4) {
                    remember?.(secret)
                    if (/(?:^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(this.file)) { remember?.(secret.replace(/\$\$/g, '$')) }
                }
            }
            fields.push({
                path: parts,
                type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
                configured: value !== null && value !== '',
                ...visible ? { value } : { hidden: true },
            })
        })
        return { exists: this.source !== null, format: this.format, fields }
    }

    apply (changes: ConfigurationChange[], resolve: (value: string, parts: (string|number)[]) => string, unrestricted = false): string {
        if (!Array.isArray(changes) || !changes.length || changes.length > 64) { throw new ConfigurationError('请提供 1 至 64 项字段修改。') }
        const before = this.value()
        const bound = new Set<string>()
        const paths: string[] = []
        for (const change of changes) {
            if (!validConfigurationPath(change.path) || !Object.prototype.hasOwnProperty.call(change, 'value') || change.value === undefined) { throw new ConfigurationError('字段修改路径或内容无效。') }
            const pointer = configurationPointer(change.path)
            if (paths.some(item => item === pointer || item.startsWith(pointer + '/') || pointer.startsWith(item + '/'))) { throw new ConfigurationError('同一批修改不能包含重叠字段。') }
            paths.push(pointer)
            let count = 0
            const convert = (value: unknown, parts: (string|number)[]): unknown => {
                if (++count > 1024 || parts.length > 32) { throw new ConfigurationError('字段修改过大。') }
                if (Array.isArray(value)) { return value.map((item, index) => convert(item, [...parts, index])) }
                if (value && typeof value === 'object') {
                    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
                        if (!validConfigurationPath([key])) { throw new ConfigurationError('字段名无效。') }
                        return [key, convert(item, [...parts, key])]
                    }))
                }
                if (typeof value === 'string') {
                    if (/__TABBY_SENSITIVE_\d+__/.test(value)) {
                        let result = resolve(value, parts)
                        if (MARKER.test(result)) { throw new ConfigurationError('密码占位符未能正确填入。') }
                        bound.add(configurationPointer(parts))
                        // Compose interpolates even quoted environment scalars; $$ is a literal dollar.
                        if (/(?:^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(this.file)) { result = result.replace(/\$/g, () => '$$') }
                        return result
                    }
                    if (MARKER.test(value)) { throw new ConfigurationError('不能将隐藏标记写入配置；不修改的字段请省略。') }
                }
                if (!unrestricted && secretField(parts, value)) { throw new ConfigurationError('密码字段请先使用本地密码框，并绑定到此文件和字段。') }
                return value
            }
            this.document.setIn(change.path, convert(change.value, change.path))
        }
        const after = this.value()
        // Parent replacement cannot silently erase or copy an existing private field.
        leaves(before, (parts, value) => {
            if (!unrestricted && parts.length && !publicField(parts, value) && !bound.has(configurationPointer(parts)) &&
                JSON.stringify(getValue(after, parts)) !== JSON.stringify(value)) {
                throw new ConfigurationError('修改会覆盖已有隐藏字段；请只修改公开字段，或通过密码框更换该字段。')
            }
        })
        let result = ''
        if (this.envLines) {
            const lines = [...this.envLines]
            const replacements: { start: number, end: number, text: string }[] = []
            for (const change of changes) {
                if (change.path.length !== 1 || typeof change.path[0] !== 'string' || !/^[A-Za-z_]\w*$/.test(change.path[0])) { throw new ConfigurationError('环境变量文件只支持顶层变量。') }
                const key = change.path[0]
                const value = getValue(after, [key])
                if (!['string', 'number', 'boolean'].includes(typeof value) || /[\r\n]/.test(String(value))) { throw new ConfigurationError('环境变量写入需要单行字符串、数字或布尔值。') }
                const text = key + '=\'' + String(value).replace(/'/g, '\\\'') + '\''
                const range = this.envRanges.get(key)
                replacements.push({ start: range?.[0] ?? lines.length, end: range?.[1] ?? lines.length - 1, text })
            }
            for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
                lines.splice(replacement.start, replacement.end - replacement.start + 1, replacement.text)
            }
            result = lines.join('\n').replace(/\n*$/, '\n')
        } else {
            result = this.format === 'json' ? JSON.stringify(after, null, 2) + '\n' : this.document.toString({ lineWidth: 0 })
        }
        if (Buffer.byteLength(result) > 1048576) { throw new ConfigurationError('配置文件超过 1 MiB。') }
        // Parse the rendered result before touching the destination.
        new ConfigurationDocument(this.file, result)
        return result
    }
}

export function configurationRisk (changes: ConfigurationChange[]): 'DANGEROUS'|'MODIFY' {
    const sensitive = new Set(['privileged', 'volumes', 'devices', 'cap_add', 'network_mode', 'command', 'entrypoint', 'user'])
    return changes.some(change => {
        const flags: boolean[] = []
        leaves(change.value, parts => { flags.push([...change.path, ...parts].some(part => sensitive.has(String(part)))) })
        return flags.includes(true)
    }) ? 'DANGEROUS' : 'MODIFY'
}
