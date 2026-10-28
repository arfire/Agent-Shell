export type CommandRisk = 'SAFE' | 'MODIFY' | 'DANGEROUS' | 'DENY'
export type ApprovalMode = 'configured' | 'auto' | 'full' | 'unrestricted'

export interface CommandRule {
    command: string
    risk: CommandRisk
}

export interface RedactionRule {
    name: string
    pattern: string
    replacement: string
    enabled?: boolean
}

export interface AIConfig {
    version: number
    web?: WebConfig
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
        forceAgentShortcut?: string
        forceShellShortcut?: string
    }
    policy: {
        approvalMode?: ApprovalMode
        commandRules?: CommandRule[]
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

export interface WebConfig {
    mode: 'off'|'auto'|'manual'
    baseURL: string
    authorization: string
    engines: string[]
    language: string
    timeoutMs: number
    maxResults: number
    maxCallsPerRun: number
    maxPageChars: number
    useDefaultModel: boolean
    model: AIConfig['llm']
}

function compilePattern (pattern: string, field: string): void {
    try {
        const normalized = pattern.startsWith('(?i)') ? pattern.substring(4) : pattern
        new RegExp(normalized)
    } catch (error) {
        throw new Error(`${field} contains an invalid regular expression: ${String(error)}`)
    }
}

export function defaultWebConfig (): WebConfig {
    return {
        mode: 'off', baseURL: '', authorization: '', engines: [], language: 'auto',
        timeoutMs: 15000, maxResults: 5, maxCallsPerRun: 8, maxPageChars: 12000,
        useDefaultModel: true,
        model: { baseURL: '', apiKey: '', model: '', temperature: 0.2, timeout: 60000 },
    }
}

export function validateWebConfig (value: unknown): asserts value is WebConfig {
    const web = value as WebConfig|undefined
    if (!web || !['off', 'auto', 'manual'].includes(web.mode) || typeof web.useDefaultModel !== 'boolean') {
        throw new Error('联网模式或“使用默认模型”选项无效')
    }
    if (typeof web.baseURL !== 'string' || typeof web.authorization !== 'string' || /[\r\n]/.test(web.authorization) ||
        typeof web.language !== 'string' || !Array.isArray(web.engines) || web.engines.some(engine => typeof engine !== 'string')) {
        throw new Error('搜索服务地址、认证、语言或引擎配置无效')
    }
    const validateURL = (address: string): void => {
        const url = new URL(address)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error('请填写 HTTP/HTTPS 服务地址，认证信息请单独填写，地址不要包含查询参数或片段')
        }
    }
    if (web.baseURL || web.mode !== 'off') { validateURL(web.baseURL) }
    for (const [name, minimum, maximum] of [
        ['timeoutMs', 1000, 120000], ['maxResults', 1, 10], ['maxCallsPerRun', 1, 20], ['maxPageChars', 1000, 30000],
    ] as const) {
        if (!Number.isInteger(web[name]) || web[name] < minimum || web[name] > maximum) {
            throw new Error(`web.${name} 必须为 ${minimum}–${maximum} 之间的整数`)
        }
    }
    const model = web.model as AIConfig['llm']|undefined
    if (!model || typeof model.baseURL !== 'string' || typeof model.apiKey !== 'string' || typeof model.model !== 'string' ||
        !Number.isInteger(model.timeout) || model.timeout < 1000 || model.timeout > 300000 ||
        !Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2) {
        throw new Error('联网模型配置无效')
    }
    if (!web.useDefaultModel && web.mode !== 'off') {
        validateURL(model.baseURL)
        if (!model.model.trim()) { throw new Error('请填写独立联网模型名称，或勾选“使用默认模型”') }
    }
}

export function validateAIConfig (value: unknown): asserts value is AIConfig {
    const config = value as (Omit<AIConfig, 'llm'> & { llm?: AIConfig['llm'] })|undefined
    if (!config || typeof config !== 'object') {
        throw new Error('Configuration root must be an object')
    }
    if (config.web !== undefined) { validateWebConfig(config.web) }
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
    if (!Number.isInteger(config.agent.maxConcurrentRuns) || config.agent.maxConcurrentRuns < 1) {
        throw new Error('agent.maxConcurrentRuns must be a positive integer')
    }
    if (!Number.isInteger(config.agent.maxContextTokens) || config.agent.maxContextTokens < 1000) {
        throw new Error('agent.maxContextTokens must be an integer of at least 1000')
    }
    if (!Number.isInteger(config.agent.recentOutputLines) || config.agent.recentOutputLines < 1) {
        throw new Error('agent.recentOutputLines must be a positive integer')
    }
    if (!Array.isArray(config.inputDetection.shellCommands) || !Array.isArray(config.inputDetection.shellPatterns)) {
        throw new Error('inputDetection command and pattern lists must be arrays')
    }
    if (config.inputDetection.shellCommands.some(command => typeof command !== 'string' || !command.trim() || /\s/.test(command))) {
        throw new Error('Shell 命令列表中，每行只能填写一个命令名')
    }
    if (config.policy.approvalMode !== undefined && !['configured', 'auto', 'full', 'unrestricted'].includes(config.policy.approvalMode)) {
        throw new Error('执行权限档位无效')
    }
    if (config.policy.commandRules !== undefined) {
        if (!Array.isArray(config.policy.commandRules)) { throw new Error('命令规则必须为列表') }
        for (const rule of config.policy.commandRules) {
            if (typeof rule.command !== 'string' || !/^[\w./:-]+(?:[ \t]+[\w./:-]+)*$/.test(rule.command) ||
                !['SAFE', 'MODIFY', 'DANGEROUS', 'DENY'].includes(rule.risk)) {
                throw new Error('请填写有效的命令或子命令，例如 git status，并选择处理方式')
            }
        }
    }
    if (!['SAFE', 'MODIFY', 'DANGEROUS', 'DENY'].includes(config.policy.defaultRisk)) {
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
    if (!Array.isArray(config.redaction.patterns)) {
        throw new Error('redaction.patterns must be an array')
    }
    if (typeof config.redaction.enabled !== 'boolean') { throw new Error('脱敏开关必须为布尔值') }
    for (const rule of config.redaction.patterns) {
        if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') { throw new Error('脱敏规则开关无效') }
        compilePattern(rule.pattern, `redaction.${rule.name}`)
    }
}
