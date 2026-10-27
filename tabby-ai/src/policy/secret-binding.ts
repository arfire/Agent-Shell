export interface SecretBinding {
    program: string
    target: string
}

/** Sudo authentication and dependent operations must share one SSH process. */
function literalCommands (source: string, allowAnd: boolean): string[][]|undefined {
    const commands: string[][] = [[]]
    let result = commands[0]
    let word = ''
    let quote = ''
    let escaped = false
    let started = false
    for (let index = 0; index < source.length; index++) {
        const char = source[index]
        if (escaped) { word += char; escaped = false; started = true; continue }
        if (char === '\\' && quote !== '\'') { escaped = true; continue }
        if (quote) {
            if (quote === '"' && /[$`]/.test(char)) { return undefined }
            if (char === quote) { quote = '' } else { word += char }
            continue
        }
        if (char === '\'' || char === '"') { quote = char; started = true; continue }
        if (/\s/.test(char)) {
            if (started) { result.push(word); word = ''; started = false }
            continue
        }
        if (allowAnd && char === '&' && source[index + 1] === '&') {
            if (started) { result.push(word); word = ''; started = false }
            if (!result.length) { return undefined }
            result = []
            commands.push(result)
            index++
            continue
        }
        if (/[;|&<>`$(){}]/.test(char)) { return undefined }
        word += char
        started = true
    }
    if (quote || escaped) { return undefined }
    if (started) { result.push(word) }
    return commands.length > 1 && !result.length ? undefined : commands
}

/** A deliberately limited argument grammar; never expands shell or environment values. */
export function literalArguments (source: string): string[]|undefined {
    return literalCommands(source, false)?.[0]
}

export function validateSecretBinding (program: unknown, target: unknown): SecretBinding|undefined {
    if (typeof program !== 'string' || typeof target !== 'string') { return undefined }
    const name = program.toLowerCase()
    if (['curl', 'wget'].includes(name)) {
        try {
            const url = new URL(target)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { return undefined }
            return { program: name, target: url.origin }
        } catch { return undefined }
    }
    if (['mysql', 'mariadb', 'mysqldump', 'psql', 'pg_dump'].includes(name) && /^[a-zA-Z0-9_.:[\]-]+$/.test(target)) {
        return { program: name, target: target.toLowerCase() }
    }
    if (name === 'sudo' && target === 'current-server') { return { program: name, target } }
    if (name === 'configuration' && /^\/[^#\r\n]+#\/[^\r\n]+$/.test(target) && !target.split('#')[0].split('/').includes('..')) {
        return { program: name, target }
    }
    return undefined
}

export function boundSecretReason (command: string, binding: SecretBinding): string|undefined {
    if (binding.program === 'configuration') { return '此密码只允许由 configuration_file 写入已绑定的配置字段，不能交给终端命令。' }
    let source = command.trim()
    if (binding.program === 'sudo') {
        // The only allowed secret pipeline delivers a password directly to sudo stdin.
        const pipe = /^printf\s+(?:'%s(?:\\n)?'|"%s(?:\\n)?")\s+['"]?__TABBY_SENSITIVE_\d+__['"]?\s*\|\s*(sudo\s+-S\b[\s\S]*)$/.exec(source)
        if (!pipe) { return '请用 printf \'%s\\n\' 占位符 | sudo -S -v && sudo -n 操作，在同一次 terminal_exec 中验证并执行。不要同时使用 -k 和 -v，密码只传给 sudo 验证。' }
        source = pipe[1]
        const commands = literalCommands(source, true)
        const validation = commands?.[0]
        const allowed = new Set(['sudo', '-S', '-v', '-p', ''])
        if (!validation?.includes('-S') || !validation.includes('-v') || !validation.every(arg => allowed.has(arg))) {
            return '请在同一次 terminal_exec 中使用 printf \'%s\\n\' 占位符 | sudo -S -v && sudo -n 操作；-k 与 -v 同时使用不会保存验证状态，也不能把验证和操作分成两条调用。'
        }
        if (commands!.slice(1).some(args => args[0] !== 'sudo' || args[1] !== '-n' || args.length < 3 || args.some(arg => /__TABBY_SENSITIVE_\d+__/.test(arg)))) {
            return 'sudo 验证后只允许用 && 连接 sudo -n 操作，操作中不再携带密码。不要添加输出管道或重定向。'
        }
        return undefined
    }
    const args = literalArguments(source)
    if (!args?.length) { return '带凭据的命令只能是可检查的单一目标程序调用，不能使用变量、重定向或复合命令。' }
    while (/^(?:MYSQL_PWD|PGPASSWORD)=__TABBY_SENSITIVE_\d+__$/.test(args[0] ?? '')) { args.shift() }
    if (args[0] !== binding.program) { return '本地凭据已绑定到 ' + binding.program + '，不能转交其他程序。' }
    if (['curl', 'wget'].includes(binding.program)) {
        if (binding.program === 'curl' && (!['-q', '--disable'].includes(args[1]) ||
            !args.some((arg, index) => arg === '--noproxy=*' || arg === '--noproxy' && args[index + 1] === '*'))) {
            return '带凭据的 curl 必须以 --disable 开始，并设置 --noproxy "*"，防止默认配置或代理改变授权目标。'
        }
        if (binding.program === 'wget' && !['--no-config', '--no-proxy', '--max-redirect=0'].every(flag => args.includes(flag))) {
            return '带凭据的 wget 必须禁用默认配置、代理和重定向（--no-config --no-proxy --max-redirect=0）。'
        }
        if (args.filter(arg => /^--noproxy(?:=|$)/.test(arg)).length > 1) { return '不能重复指定代理排除参数。' }
        if (binding.program === 'wget') {
            const options = new Set(['--no-config', '--no-proxy', '--max-redirect', '--header', '--user', '--password', '--timeout', '--tries', '--quiet', '--server-response', '--spider', '-q', '-S'])
            if (args.some(arg => arg.startsWith('-') && !options.has(arg.split('=')[0]))) { return '带凭据的 wget 只允许明确的标准参数，不能加载额外命令或连接配置。' }
        }
        if (args.some(arg => /(?:^|=)@/.test(arg))) { return '凭据网络请求不能从其他文件加载请求内容。' }
        const urls = args.filter(arg => /^https?:\/\//i.test(arg))
        if (urls.length !== 1) { return '带凭据的网络请求必须明确指定一个已授权的目标地址。' }
        try {
            const url = new URL(urls[0])
            if (url.origin !== binding.target || url.username || url.password) { return '凭据不能发送到未授权地址；已绑定目标为 ' + binding.target + '。' }
        } catch { return '目标地址无效。' }
        if (args.some(arg => /^(?:Host|:authority|Forwarded|X-Forwarded-Host|Proxy-Authorization)\s*:/i.test(arg))) {
            return '不能用请求头改写凭据的授权目标。'
        }
        if (binding.program === 'curl') {
            const options = new Set(['--disable', '--noproxy', '--connect-timeout', '--max-time', '--retry', '--retry-delay',
                '--retry-max-time', '--silent', '--show-error', '--fail', '--fail-with-body', '--head', '--request',
                '--header', '--user', '--basic', '--oauth2-bearer', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json',
                '--compressed', '--http1.1', '--http2', '-H', '-u', '-d', '-X', '-m'])
            if (args.some(arg => arg.startsWith('-') && !options.has(arg.split('=')[0]) && !/^-[qsfSI]+$/.test(arg))) {
                return '带凭据的 curl 只允许明确的标准参数；不允许未知或缩写参数改变连接目标。'
            }
        }
        // Redirects, proxies, arbitrary config and alternate destinations can change the sink.
        if (args.some(arg => /^(?:-(?:[a-zA-Z]*[LxK]|[a-zA-Z]*[LxK][a-zA-Z]*)|--(?:location(?:-trusted)?|proxy(?:1\.0)?|preproxy|config|connect-to|resolve|url|next|insecure|post-data|post-file|socks[\w-]*|unix-socket|abstract-unix-socket|request-target|alt-svc|hsts|netrc(?:-file)?|no-check-certificate))(?:=|$)/.test(arg))) {
            return '使用本地凭据时不能跟随重定向、使用代理/外部配置或改写连接目标。'
        }
        return undefined
    }
    if (args.filter(arg => /^--host(?:=|$)|^-h/.test(arg)).length !== 1) { return '数据库连接必须且只能指定一个授权主机。' }
    const hostIndex = args.findIndex(arg => ['-h', '--host'].includes(arg))
    const host = hostIndex >= 0 ? args[hostIndex + 1] : args.find(arg => arg.startsWith('--host='))?.slice(7) ?? args.find(arg => /^-h.+/.test(arg))?.slice(2)
    if (!host || host.toLowerCase() !== binding.target) { return '数据库凭据不能用于其他主机；已绑定目标为 ' + binding.target + '。' }
    if (['mysql', 'mariadb', 'mysqldump'].includes(binding.program) && args[1] !== '--no-defaults') {
        return '带凭据的 MySQL 调用必须以 --no-defaults 开始，并明确指定主机，避免读取其他连接配置。'
    }
    if (args.some(arg => /(?:^|\s)(?:host|hostaddr|service)=/i.test(arg) || /^--(?:defaults|login-path|service|file)|^-f/.test(arg) || /^(?:postgres(?:ql)?):\/\//i.test(arg))) {
        return '带凭据的数据库连接不能通过外部连接配置或 URI 改写目标。'
    }
    return undefined
}
