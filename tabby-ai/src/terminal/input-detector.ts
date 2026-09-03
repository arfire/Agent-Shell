import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'

function firstMeaningfulLine (input: string): string {
    if (!/[\r\n]/.test(input)) {
        return input
    }
    const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const candidate = lines.find(line => !line.startsWith('```') && !/^#(?!\!)/.test(line))
    return candidate ?? (lines.length ? lines[0] : '')
}

function extractFirstToken (input: string): string {
    const withoutAssignments = input.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '')
    const match = /^(?:command\s+|builtin\s+)?([^\s]+)/.exec(withoutAssignments)
    return (match?.[1] ?? '').replace(/^['"]|['"]$/g, '')
}

function looksLikeExplicitShellInput (input: string): boolean {
    if (/^(?:#!|\.{0,2}\/|~\/|[A-Za-z_][A-Za-z0-9_]*=)/.test(input)) {
        return true
    }
    const token = extractFirstToken(input)
    return [
        'if', 'then', 'elif', 'else', 'fi',
        'for', 'while', 'until', 'do', 'done',
        'case', 'esac', 'select', 'function',
        'set', 'source', 'readonly', 'local', 'declare', 'typeset',
        'printf', 'read', 'test', '[', '[[', '{', '(',
    ].includes(token)
}

function looksLikeNaturalLanguage (input: string): boolean {
    if (/[\u3400-\u9fff]/.test(input)) {
        return true
    }
    return /^(please|can you|could you|would you|help me|explain|why|how|what|check whether|deploy|install for me)\b/i.test(input)
}

@Injectable({ providedIn: 'root' })
export class AIInputDetector {
    constructor (private configService: AIConfigService) { }

    isShellCommand (input: string): boolean {
        const value = input.trim()
        if (!value) {
            return true
        }
        const firstLine = firstMeaningfulLine(value)
        if (firstLine !== value) {
            return this.isShellCommand(firstLine)
        }
        const config = this.configService.config.inputDetection
        const firstToken = extractFirstToken(value)
        if (config.shellCommands.some(command => command.toLowerCase() === firstToken.toLowerCase())) {
            return true
        }
        if (looksLikeExplicitShellInput(value)) {
            return true
        }
        // Prefer AI for prose that happens to contain shell punctuation such
        // as URLs, Markdown links or placeholders. Known commands, explicit
        // paths and assignments above still go directly to the terminal.
        if (looksLikeNaturalLanguage(value)) {
            return false
        }
        return config.shellPatterns.some(pattern => new RegExp(pattern).test(value))
    }
}
