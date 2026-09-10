import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'

const DISCOVERABLE_SENSITIVE_VALUES = [
    /\bcrpi-[a-z0-9]+(?:\.[a-z0-9-]+)*\.personal\.cr\.aliyuncs\.com(?:\/[A-Za-z0-9._-]+)+\b/gi,
    /\b(?:https?:\/\/)?[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
]

const SECRET_FIELD = /\b[\w.-]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|database_url|mysql_pwd|pgpassword)[\w.-]*\b/i

/** Core credential redaction is always active, including for existing user configs. */
function redactCredentials (content: string): string {
    // Escape sequences can otherwise split a credential name or value.
    const plain = content.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    const result = plain
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
        .replace(/(["']?([\w.-]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|database_url|mysql_pwd|pgpassword)[\w.-]*)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}\r\n]+)/gi, (match, prefix: string, key: string, value: string) => {
            if (!SECRET_FIELD.test(key) || /__TABBY_SENSITIVE_\d+__|\[REDACTED/.test(value)) { return match }
            if (/^password$/i.test(key) && /^(?:YES|NO)\)?$/i.test(value) && /using password:/i.test(content)) { return match }
            return prefix + '[REDACTED]'
        })
        .replace(/\b(?:mysql|mariadb|mysqldump)\b[^\r\n]*/gi, line => line.replace(/(^|\s)(-p)([^\s]+)/g, (match, space: string, flag: string, value: string) =>
            /__TABBY_SENSITIVE_\d+__/.test(value) ? match : space + flag + '[REDACTED]'))
        .replace(/(\bAuthorization\s*:\s*)([^\r\n]+)/gi, (match, prefix: string, value: string) =>
            /__TABBY_SENSITIVE_\d+__/.test(value) ? match : prefix + '[REDACTED]')
        .replace(/\b(https?|ssh|mysql|postgres(?:ql)?):\/\/[^\s:@/]+:[^\s@/]+@/gi, '$1://[REDACTED_CREDENTIALS]@')
    return result === plain ? content : result
}

export class SecretRedactionScope {
    private values = new Map<string, string>()

    constructor (private redactor: SecretRedactor, private allowSensitiveContent: () => boolean = () => false) { }

    protect (content: string): string {
        let result = this.replaceKnown(content)
        if (this.allowSensitiveContent()) { return result }
        for (const pattern of DISCOVERABLE_SENSITIVE_VALUES) {
            result = result.replace(pattern, value => this.register(value))
        }
        return this.redactor.redact(result)
    }

    redactKnown (content: string): string {
        const result = this.replaceKnown(content)
        return this.allowSensitiveContent() ? result : this.redactor.redact(result)
    }

    /** Keep a possible secret prefix until the next transport chunk arrives. */
    streamFilter (bufferLines = false): ((content: string) => string) & { flush: () => string } {
        let pending = ''
        let privateKey = false
        let secretQuote = ''
        const redact = (text: string): string => {
            if (this.allowSensitiveContent()) { return this.replaceKnown(text) }
            if (!bufferLines) { return this.redactKnown(text) }
            let visible = ''
            for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
                const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
                if (secretQuote) {
                    if (plain.includes(secretQuote)) { secretQuote = '' }
                    continue
                }
                const assignment = /([\w.-]+)["']?\s*[=:]\s*(["'])(.*)/.exec(plain)
                if (assignment && SECRET_FIELD.test(assignment[1]) && !assignment[3].includes(assignment[2])) {
                    secretQuote = assignment[2]
                    visible += '[REDACTED]\r\n'
                    continue
                }
                if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(plain)) {
                    privateKey = true
                    visible += '[REDACTED_PRIVATE_KEY]\r\n'
                }
                if (privateKey) {
                    if (/-----END [A-Z ]*PRIVATE KEY-----/.test(plain)) { privateKey = false }
                } else { visible += this.redactKnown(line) }
            }
            return visible
        }
        const filter = (content: string): string => {
            pending += content
            let retained = 0
            for (const value of this.values.values()) {
                for (let length = Math.min(value.length - 1, pending.length); length > retained; length--) {
                    if (pending.endsWith(value.slice(0, length))) { retained = length; break }
                }
            }
            let cutoff = pending.length - retained
            if (bufferLines) { cutoff = pending.lastIndexOf('\n', cutoff - 1) + 1 }
            for (const value of this.values.values()) {
                const start = pending.lastIndexOf(value, cutoff - 1)
                if (start >= 0 && start < cutoff && start + value.length > cutoff) { cutoff = start }
            }
            const visible = redact(pending.slice(0, cutoff))
            pending = pending.slice(cutoff)
            return visible
        }
        filter.flush = (): string => {
            const visible = redact(pending)
            pending = ''
            return visible
        }
        return filter
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

    /** Expand only as shell data; passwords containing quotes or $() stay literal. */
    restoreCommand (content: string, shell = 'bash'): string {
        let quote = ''
        let escaped = false
        let result = ''
        for (let index = 0; index < content.length; index++) {
            const placeholder = /^__TABBY_SENSITIVE_\d+__/.exec(content.slice(index))?.[0]
            if (placeholder) {
                const value = this.values.get(placeholder)
                if (value === undefined) { throw new Error('敏感值占位符已失效，请通过密码输入框重新提供') }
                if (escaped || content[index - 1] === '$') { throw new Error('敏感值占位符必须直接用作命令参数，不能转义或作为变量展开') }
                const single = shell === 'powershell' ? value.replace(/'/g, '\'\'')
                    : shell === 'fish' ? value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') : value.replace(/'/g, '\'\\\'\'')
                const double = shell === 'powershell' ? value.replace(/[`"$]/g, '`$&') : value.replace(/[\\"$`]/g, '\\$&')
                result += quote === '\'' ? single : quote === '"' ? double : '\'' + single + '\''
                index += placeholder.length - 1
                continue
            }
            const char = content[index]
            result += char
            if (escaped) { escaped = false; continue }
            if (char === (shell === 'powershell' ? '`' : '\\') && quote !== '\'') { escaped = true; continue }
            if (quote) {
                if (char === quote) { quote = '' }
            } else if (char === '\'' || char === '"') { quote = char }
        }
        return result
    }

    register (value: string): string {
        if (!value) { return '' }
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
        const web = this.configService.config.web
        for (const secret of [this.configService.config.llm.apiKey, web?.model.apiKey, web?.authorization,
            web?.authorization.replace(/^(?:Bearer|Basic)\s+/i, '')]) {
            if (secret) { content = content.split(secret).join('[REDACTED]') }
        }
        let result = redactCredentials(content)
        if (!config.enabled) {
            return result
        }
        for (const rule of config.patterns) {
            if (rule.enabled === false) { continue }
            // Old saved defaults otherwise destroy placeholders and hide MySQL's YES/NO status.
            if (rule.name === 'secret-assignment') { continue }
            const insensitive = rule.pattern.startsWith('(?i)')
            const pattern = insensitive ? rule.pattern.substring(4) : rule.pattern
            result = result.replace(new RegExp(pattern, insensitive ? 'gi' : 'g'), match => /__TABBY_SENSITIVE_\d+__/.test(match)
                ? match : match.replace(new RegExp(pattern, insensitive ? 'i' : ''), rule.replacement))
        }
        return result
    }

    createScope (allowSensitiveContent: () => boolean = () => false): SecretRedactionScope {
        return new SecretRedactionScope(this, allowSensitiveContent)
    }
}
