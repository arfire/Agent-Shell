import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { AISettingsTabComponent } from './components/aiSettingsTab.component'

@Injectable()
export class AISettingsTabProvider extends SettingsTabProvider {
    id = 'ai'
    icon = 'sparkles'
    title = 'AI'
    weight = 10

    getComponentType (): any {
        return AISettingsTabComponent
    }
}
