import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'

const DISCOVERABLE_SENSITIVE_VALUES = [
    /\bcrpi-[a-z0-9]+(?:\.[a-z0-9-]+)*\.personal\.cr\.aliyuncs\.com(?:\/[A-Za-z0-9._-]+)+\b/gi,
    /\b(?:https?:\/\/)?[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
]

export class SecretRedactionScope {
    private values = new Map<string, string>()

    constructor (private redactor: SecretRedactor) { }

    protect (content: string): string {
        let result = this.replaceKnown(content)
        for (const pattern of DISCOVERABLE_SENSITIVE_VALUES) {
            result = result.replace(pattern, value => this.register(value))
        }
        return this.redactor.redact(result)
    }

    redactKnown (content: string): string {
        return this.redactor.redact(this.replaceKnown(content))
    }

    private replaceKnown (content: string): string {
        let result = content
        for (const [placeholder, value] of this.values) {
            result = result.split(value).join(placeholder)
        }
        return result
    }

    restore (content: string): string {
        let result = content
        for (const [placeholder, value] of this.values) {
            result = result.split(placeholder).join(value)
        }
        return result
    }

    register (value: string): string {
        for (const [placeholder, registered] of this.values) {
            if (registered === value) {
                return placeholder
            }
        }
        const placeholder = `__TABBY_SENSITIVE_${this.values.size + 1}__`
        this.values.set(placeholder, value)
        return placeholder
    }
}

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

    createScope (): SecretRedactionScope {
        return new SecretRedactionScope(this)
    }
}
