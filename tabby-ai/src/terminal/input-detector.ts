import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'

@Injectable({ providedIn: 'root' })
export class AIInputDetector {
    constructor (private configService: AIConfigService) { }

    isShellCommand (input: string): boolean {
        const value = input.trim()
        if (!value) {
            return true
        }
        const config = this.configService.config.inputDetection
        if (config.shellPatterns.some(pattern => new RegExp(pattern).test(value))) {
            return true
        }
        const firstToken = extractFirstToken(value)
        return config.shellCommands.some(command => command.toLowerCase() === firstToken.toLowerCase())
    }
}

function extractFirstToken (input: string): string {
    const withoutAssignments = input.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '')
    const match = /^(?:command\s+|builtin\s+)?([^\s]+)/.exec(withoutAssignments)
    return (match?.[1] ?? '').replace(/^['"]|['"]$/g, '')
}
