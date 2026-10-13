import { Injectable } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { AIConfigService } from '../config/ai-config.service'
import { AIConfig, ApprovalMode, CommandRisk } from '../config/config-schema'
import { AISessionRuntime } from '../session/ai-session.service'

export const APPROVAL_MODES: { value: ApprovalMode, label: string, description: string }[] = [
    { value: 'configured', label: '按配置执行', description: '只读查询可自动执行；修改逐条审批，危险操作二次确认，禁止规则始终生效。' },
    { value: 'auto', label: '帮我批准', description: '自动批准单次确认的命令；双次确认仍由你确认，禁止规则和敏感读取限制继续生效。' },
    { value: 'full', label: '完全放行', description: '自动批准单次、双次确认的命令；禁止规则和敏感读取限制继续生效。' },
    { value: 'unrestricted', label: '放手一搏', description: '跳过普通命令审批和自定义禁止规则；任务边界、凭据保护及服务器账号权限始终生效。' },
]

export interface CommandAuthorization {
    mode: ApprovalMode
    policy: AIConfig['policy']
}

export function approvalAction (risk: CommandRisk, mode: ApprovalMode): 'execute'|'ask'|'deny' {
    if (mode === 'unrestricted') { return 'execute' }
    if (risk === 'DENY') { return 'deny' }
    if (risk === 'SAFE' || mode === 'full' || risk === 'MODIFY' && mode === 'auto') { return 'execute' }
    return 'ask'
}

export function permissionInstructions (mode: ApprovalMode): string {
    const description = APPROVAL_MODES.find(option => option.value === mode)?.description ?? ''
    return `Current execution permission: ${mode}. ${description}\n` +
        'Sensitive credential access is forbidden in every mode. Automatic approval never permits reading or exporting credentials. Respect the latest user task boundaries. Use request_user_input(kind="secret", program=..., target=...) only for a necessary credential; its destination is enforced locally. Credential-bearing curl must start with --disable, use --noproxy "*", and never follow redirects. MySQL calls must start with --no-defaults and explicitly specify --host. Sudo passwords are only for printf-to-sudo -S -k -v validation; execute subsequent operations with sudo -n. Existing .env files may be consumed by application startup or simple docker compose --env-file PATH up -d; never print them.'

}

@Injectable({ providedIn: 'root' })
export class AgentPermissionsService {
    readonly modes = APPROVAL_MODES
    private confirmation?: Promise<boolean>

    constructor (public config: AIConfigService, private platform: PlatformService) { }

    mode (runtime: AISessionRuntime): ApprovalMode {
        return runtime.approvalMode ?? this.config.config.policy.approvalMode ?? 'configured'
    }

    snapshot (runtime: AISessionRuntime): CommandAuthorization {
        return { mode: this.mode(runtime), policy: JSON.parse(JSON.stringify(this.config.config.policy)) as AIConfig['policy'] }
    }

    async confirmMode (mode: ApprovalMode): Promise<boolean> {
        if (mode !== 'unrestricted' || window.localStorage.ashUnrestrictedAccessAcknowledged === 'true') { return true }
        this.confirmation ??= this.confirmUnrestrictedAccess()
        try { return await this.confirmation } finally { this.confirmation = undefined }
    }

    private async confirmUnrestrictedAccess (): Promise<boolean> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: '开启“放手一搏”？',
            detail: 'Agent 将跳过普通命令审批及自定义禁止规则，可能直接删除数据或更改服务器。任务范围和凭据保护仍然生效；不能读取或外发秘密。服务器账号本身的权限仍然生效。',
            buttons: ['取消', '开启放手一搏'],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response !== 1) { return false }
        window.localStorage.ashUnrestrictedAccessAcknowledged = 'true'
        return true
    }
}
