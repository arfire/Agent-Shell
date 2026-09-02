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
    testResult: { success: boolean, message: string }|null = null
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
        this.testResult = null
        try {
            const result = await this.client.testConnection(this.model.llm)
            const reply = result.content ? ` Reply: ${result.content}` : ''
            this.testResult = {
                success: true,
                message: `Model ${result.model} responded successfully.${reply}`,
            }
            this.toastr.success(this.testResult.message, 'AI model test successful')
        } catch (error) {
            this.testResult = { success: false, message: String(error) }
            this.toastr.error(this.testResult.message, 'AI model test failed')
        } finally {
            this.testing = false
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
        this.testResult = null
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
