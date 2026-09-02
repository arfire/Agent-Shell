import { Component, HostBinding } from '@angular/core'
import { ToastrService } from 'ngx-toastr'
import { HostAppService } from 'tabby-core'

import { AIConfig } from '../config/config-schema'
import { AIConfigService } from '../config/ai-config.service'
import { ChatCompletionsClient } from '../llm/chat-completions.client'

@Component({
    templateUrl: './aiSettingsTab.component.pug',
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
    restartRequired = false

    constructor (
        public configService: AIConfigService,
        private toastr: ToastrService,
        private client: ChatCompletionsClient,
        private hostApp: HostAppService,
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

    async save (): Promise<void> {
        if (!this.model || this.saving) {
            return
        }
        this.saving = true
        try {
            await this.configService.save(this.model)
            this.restartRequired = true
            this.toastr.success('Restart Ash to apply the new AI configuration.', 'AI configuration saved')
        } catch (error) {
            this.toastr.error(String(error), 'Could not save AI configuration')
        } finally {
            this.saving = false
        }
    }

    markChanged (): void {
        this.restartRequired = false
        this.connectionResult = null
        this.modelListResult = null
        this.availableModels = []
    }

    restart (): void {
        if (!this.restartRequired || this.saving) {
            return
        }
        this.hostApp.relaunch()
    }

    private async load (): Promise<void> {
        await this.configService.ready
        this.model = JSON.parse(JSON.stringify(this.configService.config))
        this.loadError = this.configService.loadError
    }
}
