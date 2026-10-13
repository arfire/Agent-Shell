/** User-facing effects; these descriptions do not grant execution permission. */
export function commandRiskDescription (command: string, risk: string, unrestricted = false): string {
    const effects: string[] = []
    if (/\b(rm|rmdir|del|Remove-Item|truncate|DROP|TRUNCATE|FLUSHALL|FLUSHDB)\b/i.test(command)) {
        effects.push('可能删除文件或数据，执行后未必能恢复')
    }
    if (/\b(restart|stop|reboot|shutdown|kill|Stop-Service|Restart-Service)\b/i.test(command) || /\bdocker\s+compose\b.*\bdown\b/i.test(command)) {
        effects.push('可能中断服务或当前连接')
    }
    if (/\b(chmod|chown|usermod|passwd|Set-Acl)\b/i.test(command)) { effects.push('会修改权限或账号设置') }
    const fileWrites = command.replace(/\d*>&(?:\d+|-)(?=\s|$|[;&|])/g, '')
        .replace(/(?:\d*|&)>{1,2}\s*(?:\/dev\/null|NUL|\$null)(?=\s|$|[;&|])/gi, '')
    if (/(?:^|[^>])>(?!>)|\btee\b|\bsed\s+-i\b/i.test(fileWrites)) { effects.push('可能覆盖现有文件内容') }
    if (/\b(curl|wget|scp|rsync)\b/i.test(command)) { effects.push('会访问网络或传输数据，请核对目标地址') }
    if (effects.length) { return [...new Set(effects)].join('；') }
    return risk === 'SAFE' ? '' : risk === 'DENY' ? unrestricted ? '可能涉及敏感数据，当前已按放手一搏模式放行' : '当前规则禁止此操作'
        : risk === 'DANGEROUS' ? '此操作被标记为高风险，请核对命令和作用范围' : ''
}
