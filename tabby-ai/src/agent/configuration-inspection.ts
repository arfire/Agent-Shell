import { posix as path } from 'path'

export const CONFIGURATION_TOOL = {
    type: 'function' as const,
    'function': {
        name: 'configuration_status',
        description: 'Inspect a project dotenv or JSON configuration through a trusted reader. Returns presence of requested fields and validated public ports/debug flags, never credential values. The file must belong to a project directory supplied by the user. Requires python3 on the current SSH server; application startup can still consume existing config if unavailable.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path inside the user-authorized project, e.g. /srv/app/.env.' },
                keys: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'Field names established from public docs or code. Only these names are checked; no secret values are returned.' },
            },
            required: ['path', 'keys'], additionalProperties: false,
        },
    },
}

const CONFIGURATION_FILE = /(?:\/\.env(?:\.[\w-]+)?|\.(?:env|json|ya?ml|ini|conf|toml|properties|py|js|ts|sh))$/

export function projectPaths (input: string): string[] {
    const quoted = [...input.matchAll(/["'](\/[^"'\r\n]{1,1024})["']/g)]
    const exact = input.trim()
    if (/^\/[\p{L}\p{N}_. /-]+$/u.test(exact)) { return [path.normalize(exact)] }
    const values = quoted.map(match => match[1])
    for (const match of input.matchAll(/(?<![:/\p{L}\p{N}])\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+/gu)) {
        if (!quoted.some(q => match.index! >= q.index! && match.index! < q.index! + q[0].length)) { values.push(match[0]) }
    }
    return [...new Set(values.filter(p => !p.split('/').includes('..') && !/[\x00-\x1f`$]/.test(p)).map(p => path.normalize(p)))]
}

export function configurationRoots (file: unknown, goal: string, additional: string[] = []): string[] {
    if (typeof file !== 'string' || !file.startsWith('/') || file.split('/').includes('..') || /[\x00-\x1f`$]/.test(file)) { return [] }
    const normalized = path.normalize(file)
    return [...projectPaths(goal), ...additional].flatMap(root => {
        if (CONFIGURATION_FILE.test(root)) { return normalized === root ? [path.dirname(root)] : [] }
        return normalized.startsWith(root.replace(/\/$/, '') + '/') ? [root] : []
    })
}

export function validConfigurationKeys (value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(key => typeof key === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(key))
}

function quote (value: string, shell: string): string {
    if (shell === 'powershell') { return '\'' + value.replace(/'/g, '\'\'') + '\'' }
    if (shell === 'fish') { return '\'' + value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\'' }
    return '\'' + value.replace(/'/g, '\'\\\'\'') + '\''
}

const SCRIPT = `import json, os, re, sys
try:
    file, keys, roots = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
    real = os.path.realpath(file)
    if not any(os.path.commonpath([real, os.path.realpath(root)]) == os.path.realpath(root) for root in roots):
        raise PermissionError()
    if os.path.getsize(real) > 1048576:
        raise ValueError()
    with open(real, encoding='utf-8') as stream:
        text = stream.read(1048577)
    if real.endswith('.json'):
        config = json.loads(text)
    else:
        config = {}
        for line in text.splitlines():
            match = re.match(r'^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=(.*)$', line)
            if match:
                config[match.group(1)] = match.group(2).strip().strip(chr(34)).strip(chr(39))
    fields = []
    for key in keys:
        value = config
        for part in key.split('.'):
            value = value.get(part) if isinstance(value, dict) else None
        field = {'name': key, 'configured': value is not None and str(value) != ''}
        if key.lower() in ('port', 'app_port', 'http_port', 'server_port', 'server.port'):
            if re.fullmatch(r'[0-9]{1,5}', str(value)) and 1 <= int(value) <= 65535:
                field['publicValue'] = int(value)
        elif key.lower() in ('debug', 'app_debug', 'server.debug') and str(value).lower() in ('true', 'false', '0', '1'):
            field['publicValue'] = str(value).lower() in ('true', '1')
        fields.append(field)
    print(json.dumps({'fields': fields}))
except FileNotFoundError:
    print(json.dumps({'error': 'not-found'}))
except PermissionError:
    print(json.dumps({'error': 'permission'}))
except Exception:
    print(json.dumps({'error': 'invalid-format'}))
`

export function configurationCommand (file: string, keys: string[], roots: string[], shell: string): string {
    return 'python3 -c ' + [SCRIPT, file, JSON.stringify(keys), JSON.stringify(roots)].map(value => quote(value, shell)).join(' ')
}

export function configurationSummary (source: string, keys: string[]): Record<string, unknown> {
    let data: any = null
    try { data = JSON.parse(source) } catch { return { error: '配置检查未返回有效结果，请确认 python3 可用；也可让应用直接使用已有配置。' } }
    if (data?.error) { return { error: '无法读取项目配置状态，请检查路径、权限与格式。秘密内容不会发送给模型。' } }
    if (!Array.isArray(data?.fields)) { return { error: '配置检查结果无效。' } }
    const fields = keys.map(name => {
        const original = data.fields.find((field: any) => field?.name === name)
        const field: { name: string, configured: boolean, publicValue?: number|boolean } = { name, configured: original?.configured === true }
        if (['port', 'app_port', 'http_port', 'server_port', 'server.port'].includes(name.toLowerCase()) &&
            Number.isInteger(original?.publicValue) && original.publicValue >= 1 && original.publicValue <= 65535) { field.publicValue = original.publicValue }
        if (['debug', 'app_debug', 'server.debug'].includes(name.toLowerCase()) && typeof original?.publicValue === 'boolean') { field.publicValue = original.publicValue }
        return field
    })
    return { fields }
}
