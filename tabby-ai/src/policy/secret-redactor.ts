import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'

@Injectable({ providedIn: 'root' })
export class SecretRedactor {
    constructor (private configService: AIConfigService) { }

    redact (content: string): string {
        const config = this.configService.config.redaction
        if (!config.enabled) {
            return content
        }
        let result = content
        for (const rule of config.patterns) {
            const insensitive = rule.pattern.startsWith('(?i)')
            const pattern = insensitive ? rule.pattern.substring(4) : rule.pattern
            result = result.replace(new RegExp(pattern, insensitive ? 'gi' : 'g'), rule.replacement)
        }
        return result
    }
}
