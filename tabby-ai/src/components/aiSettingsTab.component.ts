import { Component, HostBinding, OnDestroy } from '@angular/core'
import { ToastrService } from 'ngx-toastr'

import { AIConfig, CommandRisk, defaultWebConfig, WebConfig } from '../config/config-schema'
import { AgentPermissionsService, approvalAction } from '../policy/agent-permissions.service'
import { CommandPolicyService } from '../policy/command-policy.service'
import { AIConfigService } from '../config/ai-config.service'
import { ChatCompletionsClient } from '../llm/chat-completions.client'
import { ModelCheck, ModelCompatibilityService } from '../llm/model-compatibility.service'
import { WebService } from '../web/web.service'

@Component({
    selector: 'ash-ai-settings',
    templateUrl: './aiSettingsTab.component.pug',
    styleUrls: ['./aiSettingsTab.component.scss'],
})
export class AISettingsTabComponent implements OnDestroy {
    @HostBinding('class.content-box') true

    model: AIConfig|null = null
    loadError: string|null = null
    saving = false
    testing = false
    loadingModels = false
    connectionResult: { success: boolean, message: string }|null = null
    modelChecks: ModelCheck[] = []
    private checkController?: AbortController
    private destroyed = false
    private checkRevision = 0
    modelListResult: { success: boolean, message: string }|null = null
    availableModels: string[] = []
    modelPickerVisible = false
    section = 'model'
    web: WebConfig = defaultWebConfig()
    webTesting = false
    webResult: { success: boolean, message: string }|null = null
    private webController?: AbortController
    private webRevision = 0
    readonly sections = [
        { id: 'model', label: '模型连接' },
        { id: 'web', label: '联网搜索' },
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
        private compatibility: ModelCompatibilityService,
        public permissions: AgentPermissionsService,
        private policy: CommandPolicyService,
        private webService: WebService,
    ) {
        void this.load()
    }

    async testConnection (): Promise<void> {
        if (!this.model || this.testing) {
            return
        }
        this.testing = true
        this.connectionResult = null
        this.modelChecks = []
        const controller = new AbortController()
        const revision = ++this.checkRevision
        this.checkController = controller
        const settings = { ...this.model.llm }
        try {
            const checks = await this.compatibility.check(settings, progress => {
                if (!this.destroyed && revision === this.checkRevision) { this.modelChecks = progress }
            }, controller.signal)
            if (this.destroyed || revision !== this.checkRevision) { return }
            const success = checks.every(check => check.state === 'passed')
            this.connectionResult = {
                success,
                message: controller.signal.aborted ? '检查已取消。' : success
                    ? '四项检查通过，可以使用 Agent。实际任务仍受模型能力和服务状态影响。'
                    : '检查未全部通过，请查看下方结果。只会聊天的模型不一定支持 Agent 执行任务。',
            }
        } catch (error) {
            if (!this.destroyed && revision === this.checkRevision) { this.connectionResult = { success: false, message: String(error) } }
        } finally {
            this.testing = false
            this.checkController = undefined
        }
    }

    cancelCheck (): void {
        this.checkController?.abort(new DOMException('检查已取消', 'AbortError'))
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.cancelCheck()
        this.cancelWebCheck()
    }

    markWebChanged (): void {
        this.webRevision++
        this.cancelWebCheck()
        this.webResult = null
    }

    setWebEngines (value: string): void {
        this.web.engines = [...new Set(value.split(/[,，]/).map(engine => engine.trim()).filter(Boolean))]
        this.markWebChanged()
    }

    cancelWebCheck (): void {
        this.webController?.abort(new DOMException('检查已取消', 'AbortError'))
    }

    async testWeb (model = false): Promise<void> {
        if (this.webTesting || !this.model) { return }
        const controller = new AbortController()
        const revision = ++this.webRevision
        this.webController = controller
        this.webTesting = true
        this.webResult = null
        try {
            let message = ''
            if (model) {
                const settings = { ...this.web.useDefaultModel ? this.model.llm : this.web.model }
                const checks = await this.compatibility.check(settings, () => undefined, controller.signal)
                const failures = checks.filter(check => check.state !== 'passed')
                if (failures.length) { throw new Error(failures.map(check => `${check.label}：${check.message}`).join('；')) }
                message = '联网模型检查通过，支持流式回答和工具调用。'
            } else {
                const settings = JSON.parse(JSON.stringify(this.web)) as WebConfig
                message = await this.webService.testConnection(settings, controller.signal)
            }
            if (!this.destroyed && revision === this.webRevision) {
                this.webResult = { success: !controller.signal.aborted, message: controller.signal.aborted ? '检查已取消。' : message }
            }
        } catch (error) {
            if (!this.destroyed && revision === this.webRevision) {
                // Never echo a model provider's response body, which may reflect credentials.
                this.webResult = { success: false, message: controller.signal.aborted ? '检查已取消。'
                    : model ? '联网模型检查失败，请检查地址、密钥、模型名称及工具调用支持。' : String(error) }
            }
        } finally {
            this.webTesting = false
            this.webController = undefined
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
        this.checkRevision++
        this.cancelCheck()
        this.modelChecks = []
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
        if (this.web.useDefaultModel) { this.markWebChanged() }
        this.checkRevision++
        this.cancelCheck()
        this.modelChecks = []
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
            const decision = this.policy.evaluate(this.previewCommand, undefined, this.model.policy)
            const action = approvalAction(decision.risk, this.model.policy.approvalMode ?? 'configured')
            const label = { execute: '自动执行', ask: decision.risk === 'DANGEROUS' ? '二次确认' : '需要审批', deny: '拦截' }[action]
            this.previewResult = `Agent 执行此命令：${label}。`
        } catch (error) { this.previewResult = String(error) }
    }

    async restoreDefaults (): Promise<void> {
        if (!this.model) { return }
        this.syncCommands()
        const defaults = await this.configService.getDefaults()
        if (this.section === 'input') { this.model.inputDetection = defaults.inputDetection }
        if (this.section === 'policy') { this.model.policy = defaults.policy }
        if (this.section === 'redaction') { this.model.redaction = defaults.redaction }
        if (this.section === 'web') {
            this.markWebChanged()
            const previous = this.web
            this.model.web = { ...defaultWebConfig(), ...defaults.web, baseURL: previous.baseURL, authorization: previous.authorization, model: { ...previous.model } }
        }
        if (this.section === 'model') {
            this.markChanged()
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
        this.model.web ??= defaultWebConfig()
        this.web = this.model.web
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
