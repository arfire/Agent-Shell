import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'
import { AIConfig, CommandRisk } from '../config/config-schema'
import { credentialAccessReason } from './credential-guard'
import { executionBoundary } from './execution-boundary'

export interface CommandPolicyDecision {
    risk: CommandRisk
    reason: string
    matchedRule?: string
    commands: string[]
}

const RISK_WEIGHT: Record<CommandRisk, number> = {
    SAFE: 0,
    MODIFY: 1,
    DANGEROUS: 2,
    DENY: 3,
}

@Injectable({ providedIn: 'root' })
export class CommandPolicyService {
    constructor (private configService: AIConfigService) { }

    evaluate (command: string, shell?: string, policy: AIConfig['policy'] = this.configService.config.policy): CommandPolicyDecision {
        const commands = splitShellCommands(command)
        const credentialError = credentialAccessReason(command)
        if (credentialError) { return { risk: 'DENY', reason: credentialError, commands } }
        let result: CommandPolicyDecision = {
            risk: 'SAFE',
            reason: 'Every command segment matched an automatic approval rule.',
            commands,
        }

        if (!commands.length) {
            return { risk: 'DENY', reason: 'Empty commands cannot be executed.', commands }
        }

        for (const segment of commands) {
            const decision = this.evaluateSegment(segment, policy)
            if (RISK_WEIGHT[decision.risk] > RISK_WEIGHT[result.risk]) {
                result = { ...decision, commands }
            }
        }
        // POSIX allow rules cannot establish the safety of PowerShell expressions
        // or Fish command substitutions. Keep deny rules and require two approvals.
        if (result.risk !== 'DENY' && (shell === 'powershell' || shell === 'fish' && /[()]/.test(command))) {
            result = { ...result, risk: 'DANGEROUS', reason: 'This shell syntax requires explicit review and two confirmations.' }
        }
        const boundary = executionBoundary(command)
        if (RISK_WEIGHT[boundary.risk] > RISK_WEIGHT[result.risk]) {
            result = { ...result, ...boundary }
        }
        return result
    }

    private evaluateSegment (segment: string, policy: AIConfig['policy']): Omit<CommandPolicyDecision, 'commands'> {
        const candidates = [...new Set([segment, unwrapCommand(segment)])]
        const custom = (policy.commandRules ?? []).filter(rule => {
            const prefix = rule.command.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
            return candidates.some(candidate => new RegExp('^\\s*' + prefix + '(?:\\s|$)').test(candidate))
        }).sort((a, b) => RISK_WEIGHT[b.risk] - RISK_WEIGHT[a.risk]).find((_rule, index) => index === 0)
        const match = (patterns: string[]): string|undefined => patterns.find(pattern => {
            const regex = createRegex(pattern)
            return candidates.some(candidate => regex.test(candidate))
        })

        let rule = match(policy.deny)
        if (rule !== undefined || custom?.risk === 'DENY') {
            return { risk: 'DENY', reason: 'A deny rule matched this command.', matchedRule: rule ?? custom?.command }
        }
        rule = match(policy.requireSecondApproval)
        if (rule !== undefined || custom?.risk === 'DANGEROUS') {
            return { risk: 'DANGEROUS', reason: 'This command requires two confirmations.', matchedRule: rule }
        }
        if (readsSensitiveFile(segment)) {
            return {
                risk: 'DENY',
                reason: 'AI commands cannot read known credential files. Ask the user for only the required value through a local secret form.',
            }
        }
        if (readsConfigurationFile(segment)) {
            return {
                risk: 'DANGEROUS',
                reason: 'This command may transmit configuration contents to the model and requires explicit confirmation.',
            }
        }
        if (containsDynamicExecution(segment)) {
            return {
                risk: maxRisk(policy.defaultRisk, 'DANGEROUS'),
                reason: 'Dynamic shell execution cannot be classified safely and requires two confirmations.',
            }
        }
        if (containsStateChangingRedirection(segment)) {
            return {
                risk: maxRisk(policy.defaultRisk, 'MODIFY'),
                reason: 'Shell output redirection may change remote state and requires approval.',
            }
        }
        if (custom) {
            return { risk: custom.risk, reason: `Matched command rule: ${custom.command}`, matchedRule: custom.command }
        }
        rule = match(policy.requireApproval)
        if (rule) {
            return { risk: 'MODIFY', reason: 'This command changes remote state and requires approval.', matchedRule: rule }
        }
        rule = match(policy.autoApprove)
        if (rule) {
            return { risk: 'SAFE', reason: 'This read-only command is approved automatically.', matchedRule: rule }
        }
        return {
            risk: policy.defaultRisk,
            reason: 'No explicit policy rule matched; the configured default risk applies.',
        }
    }
}

export function splitShellCommands (source: string): string[] {
    const result: string[] = []
    let current = ''
    let quote: 'single'|'double'|'backtick'|null = null
    let escaped = false
    let depth = 0

    const flush = () => {
        const value = current.trim()
        if (value) {
            result.push(value)
        }
        current = ''
    }

    for (let index = 0; index < source.length; index++) {
        const character = source[index]
        const next = source[index + 1]
        if (escaped) {
            current += character
            escaped = false
            continue
        }
        if (character === '\\' && quote !== 'single') {
            current += character
            escaped = true
            continue
        }
        if (quote) {
            current += character
            if (
                quote === 'single' && character === "'" ||
                quote === 'double' && character === '"' ||
                quote === 'backtick' && character === '`'
            ) {
                quote = null
            }
            continue
        }
        if (character === "'") {
            quote = 'single'
            current += character
            continue
        }
        if (character === '"') {
            quote = 'double'
            current += character
            continue
        }
        if (character === '`') {
            quote = 'backtick'
            current += character
            continue
        }
        if (character === '(' || character === '{') {
            depth++
            current += character
            continue
        }
        if (character === ')' || character === '}') {
            depth = Math.max(0, depth - 1)
            current += character
            continue
        }
        if (depth === 0 && (character === ';' || character === '|' || character === '&' || character === '\n')) {
            flush()
            if (character === next && (character === '|' || character === '&')) {
                index++
            }
            continue
        }
        current += character
    }
    flush()
    return result
}

function containsDynamicExecution (command: string): boolean {
    return /(^|\s)(eval|source|\.)\s|`|\$\(|\bxargs\b.*\b(sh|bash|zsh)\b|\b(?:sh|bash|zsh|fish)\s+(?:-\S+\s+)*-\w*c\b/i.test(command)
}

function readsSensitiveFile (command: string): boolean {
    if (!/^\s*(?:sudo\s+)?(?:cat|head|tail|less|more|grep|awk|sed|strings|xxd|od|base64|jq|yq|cp|rsync|scp)\b/i.test(command)) {
        return false
    }
    return /(?:\/etc\/(?:shadow|gshadow)|\/proc\/\d+\/environ|(?:~|\/root|\/home\/[^/\s]+)\/\.ssh(?:\/|\s|$)|(?:~|\/root|\/home\/[^/\s]+)\/\.(?:aws|azure|config\/gcloud)(?:\/|\s|$)|(?:~|\/root|\/home\/[^/\s]+)\/\.kube\/config|(?:~|\/root|\/home\/[^/\s]+)\/\.(?:docker\/config\.json|npmrc|pypirc|netrc)|(?:^|[\s'"=\/])\.env(?:\.[^/\s]+)?|(?:^|[\s'"=\/])(?:credentials?|secrets?)(?:\.[^/\s]+)?)(?=[\s'";|&]|$)/i.test(command)
}

function readsConfigurationFile (command: string): boolean {
    if (!/^\s*(?:sudo\s+)?(?:cat|head|tail|less|more|grep|awk|sed|strings|xxd|od|base64|jq|yq)\b/i.test(command)) {
        return false
    }
    return /(?:^|[\s'"=\/])(?:config(?:uration)?|settings?)(?:\.[A-Za-z0-9._-]+)?(?=[\s'";|&]|$)|\.(?:conf|ini|toml|ya?ml|json)(?=[\s'";|&]|$)/i.test(command)
}

function containsStateChangingRedirection (command: string): boolean {
    // Here-documents provide stdin and do not themselves write remote state.
    // All output redirects are conservative, including descriptor redirects.
    return /(^|[^<])>{1,2}|&>/u.test(command)
}

function unwrapCommand (command: string): string {
    let value = command.trim()
    let changed = true
    while (changed) {
        changed = false
        const wrapper = /^(?:command|builtin|nohup|time)\s+/i.exec(value)
        if (wrapper) {
            value = value.substring(wrapper[0].length).trimStart()
            changed = true
            continue
        }
        if (/^sudo(?:\s|$)/i.test(value)) {
            const unwrapped = unwrapSudo(value)
            if (unwrapped !== value) {
                value = unwrapped
                changed = true
            }
        }
    }
    return value
}

function unwrapSudo (command: string): string {
    const tokens = command.match(/(?:[^\s'\"]+|'[^']*'|\"(?:\\.|[^\"])*\")+/g) ?? []
    if (tokens[0]?.toLowerCase() !== 'sudo') {
        return command
    }
    const optionsWithArgument = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-c', '--close-from', '-t', '--command-timeout', '-r', '--chroot', '-d', '--chdir'])
    let index = 1
    while (index < tokens.length) {
        const token = tokens[index].toLowerCase()
        if (token === '--') {
            index++
            break
        }
        if (!token.startsWith('-')) {
            break
        }
        if (optionsWithArgument.has(token)) {
            index += 2
        } else {
            index++
        }
    }
    return tokens.slice(index).join(' ') || command
}

function createRegex (pattern: string): RegExp {
    const insensitive = pattern.startsWith('(?i)')
    return new RegExp(insensitive ? pattern.substring(4) : pattern, insensitive ? 'i' : '')
}

function maxRisk (first: CommandRisk, second: CommandRisk): CommandRisk {
    return RISK_WEIGHT[first] >= RISK_WEIGHT[second] ? first : second
}
