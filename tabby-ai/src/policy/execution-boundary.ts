import { CommandRisk } from '../config/config-schema'

/** A minimum risk, never lowered by configurable rules or permission presets. */
export function executionBoundary (command: string): { risk: CommandRisk, reason: string } {
    const text = command.replace(/\\\r?\n/g, '').replace(/["']/g, '')
    const destructive = /\b(?:rm|rmdir|unlink|shred|wipefs|mkfs(?:\.\w+)?|fdisk|parted|dd|Remove-Item|Clear-Disk|Format-Volume|Stop-Computer|Restart-Computer|reboot|shutdown|poweroff)\b|\b(?:docker|podman|docker-compose|podman-compose)\b[^\r\n;]*\b(?:down|prune|rm|remove)\b|\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE|DELETE\s+FROM|FLUSHALL|FLUSHDB)\b|\bgit\s+(?:clean|reset|push)\b|\bkubectl\b[^\r\n;]*\bdelete\b|\b(?:chmod|chown|icacls|Set-Acl|userdel|usermod|passwd)\b/i
    if (destructive.test(text)) {
        return { risk: 'DANGEROUS', reason: '此命令可能删除数据、重置环境或改变权限，必须对本条命令进行两次确认。执行权限和自定义规则不能跳过。' }
    }
    // Do not try to prove arbitrary shell programs read-only. Only a small,
    // literal diagnostic grammar can run without a per-command approval.
    const simple = command.trim()
    const literal = !/[\r\n;|&<>`$\\(){}\x00-\x1f]/.test(simple)
    const diagnostic = /^(?:pwd|whoami|hostname|uptime|uname(?:\s+-[asnrvmopi]+)?|date|free(?:\s+-[hmbg]+)?|df(?:\s+-[hTi]+)?|ls(?:\s+(?:-[alhdt1]+|[\w./~-]+))*|docker(?:\s+compose)?\s+ps|podman\s+ps|git\s+status(?:\s+--short)?|systemctl\s+(?:is-active|is-enabled)\s+[\w@.-]+)$/i
    if (literal && diagnostic.test(simple)) {
        return { risk: 'SAFE', reason: '已确认是有限集合内的只读状态查询。' }
    }
    return { risk: 'MODIFY', reason: '修改、脚本、复合命令和无法确认只读的操作必须逐条审批；历史对话和模型解释不能作为授权。' }
}
