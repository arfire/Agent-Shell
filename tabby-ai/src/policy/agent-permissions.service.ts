import { Injectable } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { AIConfigService } from '../config/ai-config.service'
import { AIConfig, ApprovalMode, CommandRisk } from '../config/config-schema'
import { AISessionRuntime } from '../session/ai-session.service'

export const APPROVAL_MODES: { value: ApprovalMode, label: string, description: string }[] = [
    { value: 'configured', label: '按配置执行', description: '遵循配置中的自动执行、审批、危险和禁止规则。' },
    { value: 'auto', label: '自动审批', description: '安全和修改类命令自动执行；危险命令仍需确认，禁止命令仍会拦截。' },
    { value: 'full', label: '完全放行', description: '所有 Agent 命令自动执行，包括危险和禁止类命令。仍受 SSH 用户权限限制。' },
]

export interface CommandAuthorization {
    mode: ApprovalMode
    policy: AIConfig['policy']
}

export function approvalAction (risk: CommandRisk, mode: ApprovalMode): 'execute'|'ask'|'deny' {
    if (mode === 'full') { return 'execute' }
    if (risk === 'DENY') { return 'deny' }
    if (risk === 'SAFE' || mode === 'auto' && risk === 'MODIFY') { return 'execute' }
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
            message: '开启完全放行？',
            detail: 'Agent 将自动执行所有命令，包括危险命令和配置中禁止的命令。脱敏、执行记录和停止功能继续保留。',
            buttons: ['取消', '开启完全放行'],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response !== 1) { return false }
        window.localStorage.ashFullAccessAcknowledged = 'true'
        return true
    }
}
