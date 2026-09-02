export type CommandRisk = 'SAFE' | 'MODIFY' | 'DANGEROUS' | 'DENY'

export interface RedactionRule {
    name: string
    pattern: string
    replacement: string
}

export interface AIConfig {
    version: number
    llm: {
        baseURL: string
        apiKey: string
        model: string
        temperature: number
        timeout: number
    }
    agent: {
        maxConcurrentRuns: number
        maxContextTokens: number
        recentOutputLines: number
    }
    inputDetection: {
        shellCommands: string[]
        shellPatterns: string[]
    }
    policy: {
        defaultRisk: CommandRisk
        autoApprove: string[]
        requireApproval: string[]
        requireSecondApproval: string[]
        deny: string[]
    }
    redaction: {
        enabled: boolean
        patterns: RedactionRule[]
    }
}

export function validateAIConfig (value: unknown): asserts value is AIConfig {
    const config = value as AIConfig
    if (!config || typeof config !== 'object') {
        throw new Error('Configuration root must be an object')
    }
    if (
        !config.llm ||
        typeof config.llm.baseURL !== 'string' ||
        typeof config.llm.apiKey !== 'string' ||
        typeof config.llm.model !== 'string'
    ) {
        throw new Error('llm.baseURL, llm.apiKey and llm.model must be strings')
    }
    if (!Number.isFinite(config.llm.temperature) || config.llm.temperature < 0 || config.llm.temperature > 2) {
        throw new Error('llm.temperature must be between 0 and 2')
    }
    if (!Number.isInteger(config.llm.timeout) || config.llm.timeout < 1000) {
        throw new Error('llm.timeout must be at least 1000 milliseconds')
    }
    if (!Number.isInteger(config.agent?.maxConcurrentRuns) || config.agent.maxConcurrentRuns < 1) {
        throw new Error('agent.maxConcurrentRuns must be a positive integer')
    }
    if (!Number.isInteger(config.agent.maxContextTokens) || config.agent.maxContextTokens < 1000) {
        throw new Error('agent.maxContextTokens must be an integer of at least 1000')
    }
    if (!Number.isInteger(config.agent.recentOutputLines) || config.agent.recentOutputLines < 1) {
        throw new Error('agent.recentOutputLines must be a positive integer')
    }
    if (!Array.isArray(config.inputDetection?.shellCommands) || !Array.isArray(config.inputDetection?.shellPatterns)) {
        throw new Error('inputDetection command and pattern lists must be arrays')
    }
    if (!['SAFE', 'MODIFY', 'DANGEROUS', 'DENY'].includes(config.policy?.defaultRisk)) {
        throw new Error('policy.defaultRisk is invalid')
    }
    for (const key of ['autoApprove', 'requireApproval', 'requireSecondApproval', 'deny'] as const) {
        if (!Array.isArray(config.policy[key])) {
            throw new Error(`policy.${key} must be an array`)
        }
        for (const pattern of config.policy[key]) {
            compilePattern(pattern, `policy.${key}`)
        }
    }
    for (const pattern of config.inputDetection.shellPatterns) {
        compilePattern(pattern, 'inputDetection.shellPatterns')
    }
    if (!Array.isArray(config.redaction?.patterns)) {
        throw new Error('redaction.patterns must be an array')
    }
    for (const rule of config.redaction.patterns) {
        compilePattern(rule.pattern, `redaction.${rule.name}`)
    }
}

function compilePattern (pattern: string, field: string): void {
    try {
        const normalized = pattern.startsWith('(?i)') ? pattern.substring(4) : pattern
        new RegExp(normalized)
    } catch (error) {
        throw new Error(`${field} contains an invalid regular expression: ${String(error)}`)
    }
}
