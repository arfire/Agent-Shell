import { Component, HostBinding } from '@angular/core'
import { ToastrService } from 'ngx-toastr'

import { AIConfig, CommandRisk } from '../config/config-schema'
import { AgentPermissionsService, approvalAction } from '../policy/agent-permissions.service'
import { CommandPolicyService } from '../policy/command-policy.service'
import { AIInputDetector } from '../terminal/input-detector'
import { AIConfigService } from '../config/ai-config.service'
import { ChatCompletionsClient } from '../llm/chat-completions.client'

@Component({
    selector: 'ash-ai-settings',
    templateUrl: './aiSettingsTab.component.pug',
    styleUrls: ['./aiSettingsTab.component.scss'],
})
export class AISettingsTabComponent {
    @HostBinding('class.content-box') true

    model: AIConfig|null = null
    loadError: string|null = null
    saving = false
    testing = false
    loadingModels = false
    connectionResult: { success: boolean, message: string }|null = null
    modelListResult: { success: boolean, message: string }|null = null
    availableModels: string[] = []
    modelPickerVisible = false
    section = 'model'
    readonly sections = [
        { id: 'model', label: '模型连接' }, { id: 'input', label: '命令识别' },
        { id: 'policy', label: '执行权限' }, { id: 'redaction', label: '敏感信息' },
    ]

    readonly risks: { value: CommandRisk, label: string }[] = [
        { value: 'SAFE', label: '安全 · 自动执行' }, { value: 'MODIFY', label: '修改 · 需要审批' },
        { value: 'DANGEROUS', label: '危险 · 二次确认' }, { value: 'DENY', label: '禁止执行' },
    ]

    shellCommands = ''
    previewCommand = ''
    previewResult = ''

    get modelListSize (): number {
        return Math.min(Math.max(this.availableModels.length, 1), 6)
    }

    constructor (
        public configService: AIConfigService,
        private toastr: ToastrService,
        private client: ChatCompletionsClient,
        public permissions: AgentPermissionsService,
        private policy: CommandPolicyService,
        private detector: AIInputDetector,
    ) {
        void this.load()
    }

    async testConnection (): Promise<void> {
        if (!this.model || this.testing) {
            return
        }
        this.testing = true
        this.connectionResult = null
        try {
            const result = await this.client.testConnection(this.model.llm)
            const reply = result.content ? ` Reply: ${result.content}` : ''
            this.connectionResult = {
                success: true,
                message: `Model ${result.model} responded successfully.${reply}`,
            }
            this.toastr.success(this.connectionResult.message, 'AI connection successful')
        } catch (error) {
            this.connectionResult = { success: false, message: String(error) }
            this.toastr.error(this.connectionResult.message, 'AI connection failed')
        } finally {
            this.testing = false
        }
    }

    async loadModels (): Promise<void> {
        if (!this.model || this.loadingModels) {
            return
        }
        this.modelPickerVisible = true
        this.loadingModels = true
        this.availableModels = []
        this.modelListResult = null
        try {
            this.availableModels = await this.client.listModels(this.model.llm)
            this.modelListResult = this.availableModels.length
                ? { success: true, message: `${this.availableModels.length} model(s) returned by /models.` }
                : { success: true, message: 'The /models endpoint returned no models.' }
        } catch (error) {
            this.modelListResult = { success: false, message: String(error) }
        } finally {
            this.loadingModels = false
        }
    }

    selectModel (modelId: string): void {
        if (!this.model) {
            return
        }
        this.model.llm.model = modelId
        this.connectionResult = null
    }

    async save (): Promise<void> {
        if (!this.model || this.saving) {
            return
        }
        this.saving = true
        try {
            this.syncCommands()
            if (!await this.permissions.confirmMode(this.model.policy.approvalMode ?? 'configured')) { return }
            await this.configService.save(this.model)
            this.loadError = null
            this.toastr.success('已保存，后续请求和命令使用新配置。', 'AI 设置')
        } catch (error) {
            this.toastr.error(String(error), 'Could not save AI configuration')
        } finally {
            this.saving = false
        }
    }

    markChanged (): void {
        this.connectionResult = null
        this.modelListResult = null
        this.availableModels = []
        this.modelPickerVisible = false
    }

    addRule (): void {
        this.model?.policy.commandRules?.push({ command: '', risk: 'MODIFY' })
    }

    preview (): void {
        if (!this.model || !this.previewCommand.trim()) { this.previewResult = ''; return }
        this.syncCommands()
        try {
            const shell = this.detector.isShellCommand(this.previewCommand, undefined, this.model.inputDetection)
            const decision = this.policy.evaluate(this.previewCommand, undefined, this.model.policy)
            const action = approvalAction(decision.risk, this.model.policy.approvalMode ?? 'configured')
            const label = { execute: '自动执行', ask: decision.risk === 'DANGEROUS' ? '二次确认' : '需要审批', deny: '拦截' }[action]
            this.previewResult = `自动识别：${shell ? 'Shell' : 'Agent'}；若由 Agent 执行：${label}。`
        } catch (error) { this.previewResult = String(error) }
    }

    async restoreDefaults (): Promise<void> {
        if (!this.model) { return }
        this.syncCommands()
        const defaults = await this.configService.getDefaults()
        if (this.section === 'input') { this.model.inputDetection = defaults.inputDetection }
        if (this.section === 'policy') { this.model.policy = defaults.policy }
        if (this.section === 'redaction') { this.model.redaction = defaults.redaction }
        if (this.section === 'model') {
            this.model.agent = defaults.agent
            this.model.llm.temperature = defaults.llm.temperature
            this.model.llm.timeout = defaults.llm.timeout
        }
        this.prepareModel()
        this.previewResult = ''
        this.toastr.info('当前页已恢复默认，点击保存后生效。连接地址、密钥和模型保持不变。')
    }

    private syncCommands (): void {
        if (this.model) {
            this.model.inputDetection.shellCommands = [...new Set(this.shellCommands.split(/\r?\n/).map(x => x.trim()).filter(Boolean))]
        }
    }

    private prepareModel (): void {
        if (!this.model) { return }
        this.model.policy.approvalMode ??= 'configured'
        this.model.policy.commandRules ??= []
        this.shellCommands = this.model.inputDetection.shellCommands.join('\n')
    }

    private async load (): Promise<void> {
        await this.configService.ready
        this.model = JSON.parse(JSON.stringify(this.configService.config))
        this.loadError = this.configService.loadError
        this.prepareModel()
    }
}
