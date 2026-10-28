import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'
import { AIConfig } from '../config/config-schema'

export function unwrapShellFence (input: string): string {
    const match = /^\s*```(?:bash|sh|zsh|fish|powershell|pwsh|shell)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(input)
    return match ? match[1] : input
}

/** Return logical statement starts, skipping quoted/continued lines and heredoc bodies. */
export function shellStatementLines (input: string): string[] {
    const result: string[] = []
    const heredocs: { delimiter: string, tabs: boolean }[] = []
    let quote = ''
    let continued = false
    for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
        if (heredocs.length) {
            const doc = heredocs[0]
            if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) { heredocs.shift() }
            continue
        }
        const trimmed = line.trim()
        if (!quote && (!trimmed || /^#(?!\!)/.test(trimmed))) { continue }
        if (!quote && !continued) { result.push(trimmed) }
        let escaped = false
        let unquoted = ''
        for (const char of line) {
            if (escaped) { escaped = false; continue }
            if (char === '\\' && quote !== '\'') { escaped = true; continue }
            if (quote) {
                if (char === quote) { quote = '' }
            } else if (char === '\'' || char === '"') {
                quote = char
            } else {
                unquoted += char
            }
        }
        continued = escaped || /(?:\|\|?|&&)\s*$/.test(unquoted)
        for (const match of line.matchAll(/<<(-)?\s*(['"]?)([\w.-]+)\2/g)) {
            heredocs.push({ delimiter: match[3], tabs: !!match[1] })
        }
    }
    return result
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

    isShellCommand (input: string, shell?: string, config: AIConfig['inputDetection'] = this.configService.config.inputDetection): boolean {
        const value = unwrapShellFence(input).trim()
        if (!value) {
            return true
        }
        // A command name can be the topic of a question, not the executable.
        // Keep quoted arguments and normal commands such as `echo 中文` intact.
        if (/^\S+\s+(?:为什么|怎么|如何|帮我|请帮|能不能|是否|有什么|出了什么|why\b|how\b|please\b|can you\b)/i.test(value) &&
            !/^(?:echo|printf|grep|rg|findstr)\s/i.test(value)) { return false }
        if (/[\r\n]/.test(value)) {
            const statements = shellStatementLines(value)
            if (!statements.length) { return !looksLikeNaturalLanguage(value) }
            // A script with a declared interpreter or compound shell structure is one unit.
            if (/^(?:#!|if\s|for\s|while\s|until\s|case\s|function\s)/.test(statements[0])) {
                return true
            }
            return statements.every(line => this.isShellCommand(line, shell, config))
        }
        const firstToken = extractFirstToken(value)
        if (shell === 'powershell' && /^(?:(?:Get|Set|New|Remove|Copy|Move|Rename|Test|Write|Read|Select|Where|ForEach|Sort|Format|Out|Invoke|Import|Export|Start|Stop|Restart|Clear|Add|Update|Resolve|Join|Split|Push|Pop)-[A-Za-z][\w-]*|[A-Za-z]:\\|\.\\)/i.test(firstToken)) {
            return true
        }
        if (shell === 'fish' && /^(?:functions|end|begin|switch|abbr|status|fish)(?:\s|$)/.test(value)) {
            return true
        }
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
