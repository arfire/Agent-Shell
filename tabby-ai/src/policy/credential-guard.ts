import { ApprovalMode } from '../config/config-schema'
import { literalArguments } from './secret-binding'

/** Only a literal detached startup may consume an existing dotenv file. */
export function opaqueConfigurationCommand (command: string): boolean {
    const args = literalArguments(command.trim())
    if (!args || args[0] !== 'docker' || args[1] !== 'compose') { return false }
    let index = 2
    const seen = new Set<string>()
    while (['--project-directory', '--env-file'].includes(args[index])) {
        const option = args[index++]
        const value = args[index++]
        if (seen.has(option) || !value || /[\x00-\x1f?*\[\]$`]/.test(value) || value.startsWith('-') || value.split('/').includes('..')) { return false }
        if (value.split('/').some(segment => /^\.(?:ssh|aws|azure|kube|docker|gnupg)$/.test(segment))) { return false }
        if (option === '--env-file' && !/(?:^|\/)(?:\.env(?:\.[\w-]+)?|[\w-]+\.env)$/.test(value)) { return false }
        seen.add(option)
    }
    return args[index] === 'up' && args[index + 1] === '-d' && args.length === index + 2
}

/** Only explicit credential access is denied; normal shell syntax is classified by risk. */
export function credentialAccessReason (command: string, mode: ApprovalMode = 'configured'): string|undefined {
    if (mode === 'unrestricted') { return undefined }
    if (/__TABBY_SENSITIVE_\d+__/.test(command) && /\b(?:sh|bash|zsh|fish|pwsh|powershell|python\d*|node|perl|ruby)\b[^\r\n]*\s-(?:\w*c\b|Command\b|e\b)/i.test(command)) {
        return '请将敏感值占位符直接传给目标程序，不要嵌入另一层 Shell 或脚本。'
    }
    let expanded = command.replace(/\\\r?\n/g, '')
    expanded = expanded.replace(/(?:"([^"]*)"|'([^']*)')\s*\+\s*(?:"([^"]*)"|'([^']*)')/g,
        (_match, a: string|undefined, b: string|undefined, c: string|undefined, d: string|undefined) => '\'' + (a ?? b) + (c ?? d) + '\'')
    const encoded = /(?:printf|echo)\s+['"]?([A-Za-z0-9+/=]{8,})['"]?\s*\|\s*base64\s+(?:-d|--decode)\s*\|\s*(?:sh|bash|zsh)\b/.exec(command)
    if (encoded) { expanded += '\n' + Buffer.from(encoded[1], 'base64').toString('utf8') }
    // Resolve only literal assignments, without evaluating shell code or rejecting other variables.
    for (const match of command.matchAll(/(?:^|[;&\n])\s*([A-Za-z_]\w*)=(?:"([^"$\x60]*)"|'([^']*)'|([^\s;$\x60]+))/g)) {
        const value = match.slice(2).find(Boolean) ?? ''
        expanded = expanded.replace(new RegExp('\\$(?:\\{' + match[1] + '\\}|' + match[1] + '(?=\\b|["\\\']))', 'g'), value)
    }
    const literal = expanded.replace(/["']/g, '')
    const normalized = literal.replace(/\\(?=[.\w])/g, '').replace(/\\/g, '/')
    const reads = /\b(?:cat|head|tail|cut|less|more|awk|sed|grep|rg|ag|strings|xxd|od|cp|mv|ln|scp|rsync|tar|zip|Get-Content|Select-String|open|readFile|readFileSync|read_text|read_bytes)\b/i.test(normalized)
    if (opaqueConfigurationCommand(command)) { return undefined }
    if (/\btar\s+(?:-?[a-zA-Z]*c[a-zA-Z]*f|-?[a-zA-Z]*f[a-zA-Z]*c)\s+-(?:\s|$)|\bzip\s+(?:-[\w]+\s+)*-(?:\s|$)/.test(command)) {
        return '请将归档写入服务器上的文件，不要把目录的原始归档内容直接返回模型。正常压缩、解压和列表操作可以使用。'
    }
    const privatePath = /(?:^|[\s/=(:])(?:\.env(?:[.\w-]*)|\.ssh(?:\/[^\s;|&)]*)?|\.aws(?:\/[^\s;|&)]*)?|\.azure(?:\/[^\s;|&)]*)?|\.config\/gcloud(?:\/[^\s;|&)]*)?|\.kube\/config|\.docker\/config\.json|\.(?:npmrc|pypirc|netrc|my\.cnf|pgpass)|id_(?:rsa|dsa|ecdsa|ed25519)|(?:credentials?|secrets?)(?:[.\w-]*))(?=$|[\s/;|&)])|\/etc\/(?:g?shadow)\b|\/proc\/(?:\d+|self|thread-self|\*)\/environ\b|\.(?:pem|p12|pfx|key|kdbx)(?=$|[\s;|&)])|\/\.ash-config-[^/\s]+/i
    if ((reads || /\b(?:docker\s+compose|docker-compose)\b/.test(normalized)) &&
        (privatePath.test(normalized) || /(?:^|\/)\.e[?*][^\s/]*/.test(normalized))) {
        return '凭据文件请通过 configuration_file 获取字段状态；私钥、认证存储和密码备份不向模型提供原文。需要新密码时使用本地密码框。'
    }
    const validation = literalArguments(command.trim())
    if (validation?.[0] === 'docker' && validation[1] === 'compose') {
        let index = 2
        if (['-f', '--file'].includes(validation[index])) { index += 2 }
        if (validation[index] === 'config' && ['-q', '--quiet'].includes(validation[index + 1]) && validation.length === index + 2) { return undefined }
    }
    if (/\b(?:open|readFile|readFileSync|read_text|read_bytes)\b/.test(normalized) &&
        /\b(?:config|settings|appsettings|application|docker-compose|compose)[\w.-]*\.(?:ya?ml|json|ini|conf|toml|properties)\b/i.test(normalized)) {
        return '配置文件请使用 configuration_file，模型只接收公开字段，隐藏字段由程序保留。'
    }
    const configReads = [...command.matchAll(/\b(?:cat|head|tail|less|more|Get-Content|type|grep|rg|Select-String|jq|yq|awk|sed|cp|scp|rsync)\b([^;\r\n|]*)/gi)]
    if (configReads.some(match => /\b(?:config|settings|appsettings|application|docker-compose|compose)[\w.-]*\.(?:ya?ml|json|ini|conf|toml|properties)\b/i.test(
        match[1].replace(/(?:\d*>>?|\d*<<-?)\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g, '').replace(/["']/g, '').replace(/\\(?=[.\w])/g, '')))) {
        return '请通过 configuration_file 读取或修改配置：普通字段可见，已有密码保持不变。'
    }
    const envDump = /\b(?:printenv|GetEnvironmentVariables?)\b|(?:^|[\s;|&])(?:env|set|export|declare|typeset)(?:\s+-[a-zA-Z0-9]+)*(?=\s*(?:$|[;|&]))|\b(?:Get-ChildItem|gci|dir|Get-Item|Get-Content)\s+(?:-[\w-]+\s+)*env:|\b(?:os\.environ|process\.env)(?![.\w[])|\bvars\s*\(os\)[^\n]*environ/i
    const secretVariable = [...command.matchAll(/\$env:([A-Za-z_]\w*)|\$\{?([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/gi)].some(match => {
        const name = match.slice(1).find(Boolean) ?? ''
        return !/^(?:PWD|OLDPWD)$/i.test(name) && /password|passwd|pwd|token|secret|api_?key|private_?key|access_?key/i.test(name)
    })
    const credentialQuery = /\bkubectl\b[^\r\n;|&]*\b(?:secrets?|config\s+view)\b|\b(?:aws|az|gcloud|vault|op|bw|security|cmdkey|secret-tool)\b[^\r\n;|&]*\b(?:secrets?\b|secretsmanager|ssm|get-password|credential|lookup|find-generic-password|find-internet-password|read\b)|\bmysql\.(?:user|global_priv)\b|\bpg_authid\b|\b(?:169\.254\.169\.254|169\.254\.170\.2|metadata\.google\.internal)\b|\b(?:Get-Credential|Get-StoredCredential|Get-Secret|keyring|keytar)\b|\.(?:git-credentials|bash_history|zsh_history|psql_history|mysql_history)\b/i
    const inspect = /\b(?:docker|podman)\b[^\r\n;|&]*\binspect\b/.test(normalized)
    const fullInspect = inspect && (!/(?:--format|-f)(?:=|\s)/.test(command) || /(?:\.Env\b|\.Config\b(?!\.Image\b))/.test(command))
    const composeDump = /\b(?:docker\s+compose|docker-compose|podman\s+compose|podman-compose)\b[^\r\n;|&]*\bconfig\b/.test(normalized)
    const cloudSecret = /\b(?:aws|az|gcloud|vault|op|bw)\b[^\r\n;]*\b[\w.-]*(?:password|passwd|token|secret|credential|api_?key|private_?key)[\w.-]*\b/i.test(normalized)
    if (envDump.test(command) || secretVariable || credentialQuery.test(normalized) || cloudSecret || fullInspect || composeDump) {
        return '请勿导出完整环境、认证存储或容器配置。可查询具体状态字段，项目配置使用 configuration_file。'
    }
    const passwords = [...command.matchAll(/(?:^|\s)(?:-p([^\s]+)|--password(?:=|\s+)([^\s]+))|\b[\w]*(?:PASSWORD|PASSWD|MYSQL_PWD|PGPASSWORD)\s*=\s*("[^"]*"|'[^']*'|[^\s;]+)/gi)]
    if (passwords.some(match => {
        if (match[1] && (match[0].trimStart().startsWith('-P') || !/\b(?:mysql|mariadb|mysqldump)\b/i.test(command))) { return false }
        return !/^["']?__TABBY_SENSITIVE_\d+__["']?$/.test(match[1] || match[2] || match[3])
    })) { return '请勿直接填入密码；使用本地密码框获取占位符，配置字段交由 configuration_file 填入。' }
    return undefined
}
