/* eslint-disable @typescript-eslint/no-extraneous-class */
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgModule } from '@angular/core'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { AISettingsTabComponent } from './components/aiSettingsTab.component'
import { AISettingsTabProvider } from './settings'
import { AITerminalDecorator } from './terminal/ai-terminal.decorator'
import { AIInlineBlockComponent } from './ui/ai-inline-block.component'

@NgModule({
    imports: [CommonModule, FormsModule, NgbModule, ToastrModule],
    declarations: [AISettingsTabComponent, AIInlineBlockComponent],
    providers: [
        { provide: SettingsTabProvider, useClass: AISettingsTabProvider, multi: true },
        { provide: TerminalDecorator, useClass: AITerminalDecorator, multi: true },
    ],
})
export default class AIModule { }

export { AIConfigService } from './config/ai-config.service'
export * from './config/config-schema'
export { ChatCompletionsClient } from './llm/chat-completions.client'
export { CommandPolicyService } from './policy/command-policy.service'
export { SecretRedactor } from './policy/secret-redactor'
export { AISessionService } from './session/ai-session.service'
export { AISessionStore } from './session/session-store'
export { AIInputDetector } from './terminal/input-detector'
