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

/** Credential privacy applies to the three restricted permission tiers. */
export function credentialAccessReason (command: string, mode: ApprovalMode = 'configured'): string|undefined {
    if (mode === 'unrestricted') { return undefined }
    // Also inspect quoted fragments and escaped paths inside shell/interpreter wrappers.
    const literal = command.replace(/\\\r?\n/g, '').replace(/["']/g, '')
    const normalized = literal.replace(/\\/g, '/') + '\n' + literal.replace(/\\(?=[.\w])/g, '').replace(/\\/g, '/')
    if (/__TABBY_SENSITIVE_\d+__/.test(command) && /\b(?:sh|bash|zsh|fish|pwsh|powershell|python\d*|node|perl|ruby)\b[^\r\n]*\s-(?:\w*c\b|Command\b|e\b)/i.test(command)) {
        return '请将敏感值占位符直接传给目标程序，不要嵌入另一层 Shell 或脚本，以免凭据被重新解释为代码。'
    }
    const fileOperations = [...command.matchAll(/\b(?:cat|head|tail|cut|awk|sed|grep|rg|ag|strings|xxd|od|cp|mv|ln|scp|rsync|tar|zip|Get-Content|Get-Item|Select-String)\b([^;\r\n|]*)/gi)]
    if (fileOperations.some(match => /[?*\[\]]|\$[a-zA-Z_]|\$\(/.test(match[1]))) {
        return '文件读取、复制和打包不能使用通配符或变量拼接路径。请使用明确的公开文件路径；已有配置应由目标程序直接使用。'
    }
    if (/\b(?:tar|zip)\b/.test(normalized)) {
        return 'Agent 不能自行打包整个目录，目录内可能包含凭据。请使用已确认不含秘密的发布产物。'
    }
    if (/\b(?:vars|globals|locals|__dict__|__getattribute__|getattr)\b/.test(normalized) && /\b(?:python\d*|node|perl|ruby)\b/.test(normalized)) {
        return '不能通过脚本反射访问环境或隐藏数据。请使用明确的环境状态查询或本地凭据表单。'
    }
    if (/\b(?:python\d*|node|perl|ruby)\b[^\r\n]*\s-(?:c|e)\b/.test(normalized) &&
        /\b(?:open|readFile|readFileSync|read_text|read_bytes|iterdir|listdir|walk|glob)\b/.test(normalized)) {
        return '脚本不能直接读取文件内容。需要配置时请使用 configuration_status 获取字段状态或公开端口；已有配置可由应用直接使用。'
    }
    if (opaqueConfigurationCommand(command)) { return undefined }
    const path = /(?:^|[\s/=(:])(?:\.env(?:[.\w-]*)|\.ssh(?:\/[^\s;|&)]*)?|\.aws(?:\/[^\s;|&)]*)?|\.azure(?:\/[^\s;|&)]*)?|\.config\/gcloud(?:\/[^\s;|&)]*)?|\.kube\/config|\.docker\/config\.json|\.(?:npmrc|pypirc|netrc|my\.cnf|pgpass)|(?:id_(?:rsa|dsa|ecdsa|ed25519))|(?:credentials?|secrets?)(?:[.\w-]*))(?=$|[\s/;|&)])|\/etc\/(?:g?shadow)\b|\/proc\/(?:\d+|self|thread-self|\*)\/environ\b|\.(?:pem|p12|pfx|key|kdbx)(?=$|[\s;|&)])/i
    if (path.test(normalized)) {
        return 'Agent 不得访问凭据文件。需要密码或密钥时，请调用 request_user_input(kind="secret")，只索取本次操作需要的值。'
    }
    const validation = literalArguments(command.trim())
    if (validation?.[0] === 'docker' && validation[1] === 'compose') {
        let index = 2
        if (['-f', '--file'].includes(validation[index])) { index += 2 }
        if (validation[index] === 'config' && ['-q', '--quiet'].includes(validation[index + 1]) && validation.length === index + 2) { return undefined }
    }
    const environment = /\b(?:printenv|GetEnvironmentVariables?|GetEnvironmentVariable|os\.environ|getenv|process\.env|System\.getenv)\b|(?:^|[\s;|&])(?:env|set|export|declare|typeset)(?:\s+-[a-zA-Z0-9]+)*(?=\s*(?:$|[;|&]))|\b(?:Get-ChildItem|gci|dir|Get-Item|Get-Content)\s+(?:-[\w-]+\s+)*env:|\$env:/i
    const secretVariable = /(?:\$\{?|%)[\w]*(?:password|passwd|pwd|token|secret|api_?key|private_?key|access_?key)[\w]*(?:\}|%)?|\b(?:get|list|show|retrieve)[-_ ]?(?:password|secret|credential)s?\b/i
    const exports = /\b(?:docker|podman)\b[^\r\n;|&]*\b(?:inspect|config)\b|\b(?:docker-compose|podman-compose)\b[^\r\n;|&]*\bconfig\b|\bkubectl\b[^\r\n;|&]*\b(?:secrets?|config\s+view)\b|\b(?:aws|az|gcloud|vault|op|bw|security|cmdkey|secret-tool)\b[^\r\n;|&]*\b(?:secrets?\b|secretsmanager|ssm|get-password|credential|lookup|find-generic-password|find-internet-password|read\b)|\b(?:systemctl\s+show|ps\s+[^\r\n]*e[fw]|docker\s+exec[^\r\n]*\benv)\b|\bmysql\.(?:user|global_priv)\b|\bpg_authid\b/i
    const search = /\b(?:grep|rg|ag|findstr|Select-String|jq|yq|aws|az|gcloud|vault|op|bw)\b[^\r\n;]*\b[\w.-]*(?:password|passwd|token|secret|credential|api_?key|private_?key)[\w.-]*\b|\b(?:169\.254\.169\.254|169\.254\.170\.2|metadata\.google\.internal)\b|\b(?:Get-Credential|Get-StoredCredential|Get-Secret|keyring|keytar)\b|\.(?:git-credentials|bash_history|zsh_history|psql_history|mysql_history)\b/i
    const configPath = /\b(?:config|settings|appsettings|application|docker-compose|compose)[\w.-]*\.(?:ya?ml|json|ini|conf|toml|properties)\b/i
    const configReads = [...command.matchAll(/\b(?:cat|head|tail|less|more|Get-Content|type|grep|rg|Select-String|jq|yq|awk|sed|cp|scp|rsync|tar|zip)\b([^;\r\n|]*)/gi)]
    // Output files and heredoc delimiters are not input files.
    const bulkConfig = configReads.some(match => {
        const inputs = match[1].replace(/(?:\d*>>?|\d*<<-?)\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g, '').replace(/["']/g, '')
        return configPath.test(inputs) || configPath.test(inputs.replace(/\\(?=[.\w])/g, ''))
    })
    if (environment.test(normalized) || secretVariable.test(normalized) || exports.test(normalized) || search.test(normalized) || bulkConfig) {
        return 'Agent 不得自行提取环境变量、容器配置、凭据存储或数据库认证信息。请使用 request_user_input(kind="secret") 获取必要凭据。'
    }
    const obscuredExecution = /\b(?:eval|Invoke-Expression|iex)\b|\b(?:base64|b64decode|frombase64string|atob|fromCharCode|String\.fromCodePoint|bytes\.fromhex|Buffer\.from)\b|-(?:enc|encodedcommand)\b|\$\{|\$\x27|\b(?:exec|compile)\s*\(/i
    const obscuredSyntax = obscuredExecution.exec(command)?.[0] ?? /["']\s*\+\s*["']|\b(?:chr|char)\s*\(|\\x[\da-f]{2}|\\u[\da-f]{4}/i.exec(command)?.[0]
    if (obscuredSyntax) {
        return `命令包含当前凭据检查无法验证的语法“${obscuredSyntax}”，本次命令未执行。检查范围包含整段命令和写入的脚本内容，并非一律禁止 heredoc。请在原任务范围内改用可直接检查的明文命令；不要建议用户手动绕过检查。需要凭据时使用密码输入框。`
    }
    // Never accept guessed/literal passwords in model-generated login commands.
    const literals = [...command.matchAll(/(?:^|\s)(?:-p([^\s]+)|--password(?:=|\s+)([^\s]+))|\b[\w]*(?:PASSWORD|PASSWD|MYSQL_PWD|PGPASSWORD)\s*=\s*("[^"]*"|'[^']*'|[^\s;]+)/gi)]
    if (literals.some(match => {
        if (match[1] && match[0].trimStart().startsWith('-P')) { return false }
        if (match[1] && !/\b(?:mysql|mariadb|mysqldump)\b/i.test(command)) { return false }
        return !/^["']?__TABBY_SENSITIVE_\d+__["']?$/.test(match[1] || match[2] || match[3])
    })) {
        return '请勿猜测或直接填入密码。请调用 request_user_input(kind="secret") 并在命令中使用返回的占位符。'
    }
    return undefined
}
