import { Injectable } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { AIConfigService } from '../config/ai-config.service'
import { AIConfig, ApprovalMode, CommandRisk } from '../config/config-schema'
import { AISessionRuntime } from '../session/ai-session.service'

export const APPROVAL_MODES: { value: ApprovalMode, label: string, description: string }[] = [
    { value: 'configured', label: '按配置执行', description: '只读查询可自动执行；修改逐条审批，危险操作二次确认，禁止规则始终生效。' },
    { value: 'auto', label: '帮我批准', description: '自动批准单次确认的命令；双次确认仍由你确认，禁止规则和敏感读取限制继续生效。' },
    { value: 'full', label: '完全放行', description: '自动批准单次、双次确认的命令；禁止规则和敏感读取限制继续生效。' },
    { value: 'unrestricted', label: '放手一搏', description: '跳过命令审批、禁止规则和敏感读取限制。配置和凭据可能发送给模型服务商；仍受服务器账号权限限制。' },
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
    return `Current execution permission: ${mode}. ${description}\n` + (mode === 'unrestricted'
        ? 'The user has enabled unrestricted execution. You may execute commands, read configuration and credentials needed for the authorized task without per-command approval. Tool outputs may include sensitive values. Do not claim that credential reads are forbidden in this mode. Operating-system permissions and the user\'s task scope still apply.'
        : 'Sensitive configuration and credential access is forbidden in this mode, even if ordinary commands are auto-approved. Abandon attempts to obtain protected data: do not read, search, copy, encode, infer or extract it using scripts, alternate tools, environment dumps, container inspection or network commands. A refusal is final for that protected operation; do not suggest a manual bypass or repeatedly request elevation. Continue permitted work. Ask for only a required credential through request_user_input(kind="secret"). Never send private configuration, logs, private addresses or credentials to search tools or external services.')
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
            detail: 'Agent 将跳过命令审批、禁止规则和敏感读取限制，可直接读取配置和凭据。这些内容可能发送给模型服务商，也可能被命令传到网络。服务器账号本身的权限仍然生效。',
            buttons: ['取消', '开启放手一搏'],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response !== 1) { return false }
        window.localStorage.ashUnrestrictedAccessAcknowledged = 'true'
        return true
    }
}
