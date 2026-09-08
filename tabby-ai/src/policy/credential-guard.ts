/** Mandatory Agent boundary, independent of configurable command approvals. */
export function credentialAccessReason (command: string): string|undefined {
    // Also inspect quoted fragments and escaped paths inside shell/interpreter wrappers.
    const literal = command.replace(/\\\r?\n/g, '').replace(/["']/g, '')
    const normalized = literal.replace(/\\/g, '/') + '\n' + literal.replace(/\\(?=[.\w])/g, '').replace(/\\/g, '/')
    if (/__TABBY_SENSITIVE_\d+__/.test(command) && /\b(?:sh|bash|zsh|fish|pwsh|powershell|python\d*|node|perl|ruby)\b[^\r\n]*\s-(?:\w*c\b|Command\b|e\b)/i.test(command)) {
        return '请将敏感值占位符直接传给目标程序，不要嵌入另一层 Shell 或脚本，以免凭据被重新解释为代码。'
    }
    const path = /(?:^|[\s/=(:])(?:\.env(?:[.\w-]*)|\.ssh(?:\/[^\s;|&)]*)?|\.aws(?:\/[^\s;|&)]*)?|\.azure(?:\/[^\s;|&)]*)?|\.config\/gcloud(?:\/[^\s;|&)]*)?|\.kube\/config|\.docker\/config\.json|\.(?:npmrc|pypirc|netrc|my\.cnf|pgpass)|(?:id_(?:rsa|dsa|ecdsa|ed25519))|(?:credentials?|secrets?)(?:[.\w-]*))(?=$|[\s/;|&)])|\/etc\/(?:g?shadow)\b|\/proc\/(?:\d+|self|thread-self|\*)\/environ\b|\.(?:pem|p12|pfx|key|kdbx)(?=$|[\s;|&)])/i
    if (path.test(normalized)) {
        return 'Agent 不得访问凭据文件。需要密码或密钥时，请调用 request_user_input(kind="secret")，只索取本次操作需要的值。'
    }
    const environment = /\b(?:printenv|GetEnvironmentVariables?|GetEnvironmentVariable|os\.environ|getenv|process\.env|System\.getenv)\b|(?:^|[\s;|&])(?:env|set|export|declare|typeset)(?:\s+-[a-zA-Z0-9]+)*(?=\s*(?:$|[;|&]))|\b(?:Get-ChildItem|gci|dir|Get-Item|Get-Content)\s+(?:-[\w-]+\s+)*env:|\$env:/i
    const secretVariable = /(?:\$\{?|%)[\w]*(?:password|passwd|pwd|token|secret|api_?key|private_?key|access_?key)[\w]*(?:\}|%)?|\b(?:get|list|show|retrieve)[-_ ]?(?:password|secret|credential)s?\b/i
    const exports = /\b(?:docker|podman)\b[^\r\n;|&]*\b(?:inspect|config)\b|\b(?:docker-compose|podman-compose)\b[^\r\n;|&]*\bconfig\b|\bkubectl\b[^\r\n;|&]*\b(?:secrets?|config\s+view)\b|\b(?:aws|az|gcloud|vault|op|bw|security|cmdkey|secret-tool)\b[^\r\n;|&]*\b(?:secrets?\b|secretsmanager|ssm|get-password|credential|lookup|find-generic-password|find-internet-password|read\b)|\b(?:systemctl\s+show|ps\s+[^\r\n]*e[fw]|docker\s+exec[^\r\n]*\benv)\b|\bmysql\.(?:user|global_priv)\b|\bpg_authid\b/i
    const search = /\b(?:grep|rg|ag|findstr|Select-String|jq|yq|aws|az|gcloud|vault|op|bw)\b[^\r\n;]*\b[\w.-]*(?:password|passwd|token|secret|credential|api_?key|private_?key)[\w.-]*\b|\b(?:169\.254\.169\.254|169\.254\.170\.2|metadata\.google\.internal)\b|\b(?:Get-Credential|Get-StoredCredential|Get-Secret|keyring|keytar)\b|\.(?:git-credentials|bash_history|zsh_history|psql_history|mysql_history)\b/i
    const bulkConfig = /\b(?:cat|head|tail|less|more|Get-Content|type)\s+[^\r\n;]*\b(?:config|settings|appsettings|application|docker-compose|compose)[\w.-]*\.(?:ya?ml|json|ini|conf|toml|properties)\b/i
    if (environment.test(normalized) || secretVariable.test(normalized) || exports.test(normalized) || search.test(normalized) || bulkConfig.test(normalized)) {
        return 'Agent 不得自行提取环境变量、容器配置、凭据存储或数据库认证信息。请使用 request_user_input(kind="secret") 获取必要凭据。'
    }
    const obscuredExecution = /\b(?:eval|Invoke-Expression|iex)\b|\b(?:base64|b64decode|frombase64string|atob|fromCharCode|String\.fromCodePoint|bytes\.fromhex|Buffer\.from)\b|-(?:enc|encodedcommand)\b|\$\{|\$\x27|\b(?:exec|compile)\s*\(/i
    if (obscuredExecution.test(command) || /["']\s*\+\s*["']|\b(?:chr|char)\s*\(|\\x[\da-f]{2}|\\u[\da-f]{4}/i.test(command)) {
        return 'Agent 无法检查动态拼接或编码执行的命令是否访问凭据。请改用可直接检查的明文命令；需要凭据时使用密码输入框。'
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
