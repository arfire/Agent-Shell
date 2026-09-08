import { Injectable } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { AIConfigService } from '../config/ai-config.service'
import { AIConfig, ApprovalMode, CommandRisk } from '../config/config-schema'
import { AISessionRuntime } from '../session/ai-session.service'

export const APPROVAL_MODES: { value: ApprovalMode, label: string, description: string }[] = [
    { value: 'configured', label: '按配置执行', description: '只读查询可自动执行；修改逐条审批，危险操作二次确认，禁止规则始终生效。' },
    { value: 'auto', label: '只读自动', description: '仅经本地确认的只读状态查询可自动执行；修改和未知命令仍需逐条审批。' },
    { value: 'full', label: '逐条确认（原完全放行）', description: '旧完全放行模式已收紧：所有命令逐条确认，危险操作二次确认，禁止规则不能绕过。' },
]

export interface CommandAuthorization {
    mode: ApprovalMode
    policy: AIConfig['policy']
}

export function approvalAction (risk: CommandRisk, mode: ApprovalMode): 'execute'|'ask'|'deny' {
    if (risk === 'DENY') { return 'deny' }
    if (risk === 'SAFE' && mode !== 'full') { return 'execute' }
    return 'ask'
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
        if (mode !== 'full' || window.localStorage.ashFullAccessAcknowledged === 'true') { return true }
        this.confirmation ??= this.confirmFullAccess()
        try { return await this.confirmation } finally { this.confirmation = undefined }
    }

    private async confirmFullAccess (): Promise<boolean> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: '切换为逐条确认？',
            detail: '旧完全放行已停用。每条 Agent 命令都需要你确认，危险操作需要两次确认，禁止命令不会执行。',
            buttons: ['取消', '逐条确认'],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response !== 1) { return false }
        window.localStorage.ashFullAccessAcknowledged = 'true'
        return true
    }
}
