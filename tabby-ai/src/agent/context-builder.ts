import { Injectable } from '@angular/core'

import { ChatMessage } from '../llm/chat-completions.client'
import { AIConfigService } from '../config/ai-config.service'
import { SecretRedactor } from '../policy/secret-redactor'
import { AISessionRuntime } from '../session/ai-session.service'
import { SessionEvent } from '../session/session-event'

const SYSTEM_PROMPT = `You are an AI operations agent embedded in a Linux SSH terminal.
Work only in the current SSH session. Use terminal_exec to inspect, change, and verify the server.
Execute one command step at a time, observe its output and exit code, then decide the next step.
Combined Linux shell syntax is allowed inside one command step.
Never claim success without verification. Never invent command output.
The local policy engine, not you, determines approval requirements.
If the user asks for analysis only or says not to execute, do not call tools.
Keep user-facing explanations concise and describe the reason for every command.`

@Injectable({ providedIn: 'root' })
export class AgentContextBuilder {
    constructor (
        private redactor: SecretRedactor,
        private config: AIConfigService,
    ) { }

    build (runtime: AISessionRuntime, input: string, maxTokens: number): ChatMessage[] {
        const profile = runtime.tab.profile
        const header = {
            host: profile.options.host,
            port: profile.options.port,
            user: profile.options.user,
            profile: profile.name,
            shellSupport: ['bash', 'zsh', 'sh'],
        }
        const budget = Math.max(4000, maxTokens * 4)
        const historyEvents = [...runtime.events.value]
        const latest = historyEvents.at(-1)
        if (latest?.type === 'user-ai-input' && (latest.data as any)?.content === input) {
            historyEvents.pop()
        }
        const history = this.selectHistory(
            historyEvents,
            budget,
            this.config.config.agent.recentOutputLines,
        )
        return [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'system',
                content: this.redactor.redact(`Current SSH session:\n${JSON.stringify(header)}\nRecent session timeline:\n${history}`),
            },
            { role: 'user', content: this.redactor.redact(input) },
        ]
    }

    private selectHistory (events: SessionEvent[], budget: number, maximumOutputLines: number): string {
        const selected: string[] = []
        let size = 0
        let outputLinesRemaining = maximumOutputLines
        let omitted = 0
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index]
            let outputLineLimit: number|undefined
            if (event.type === 'ssh-output') {
                if (outputLinesRemaining <= 0) {
                    omitted++
                    continue
                }
                outputLineLimit = outputLinesRemaining
                const content = String((event.data as any)?.content ?? '')
                outputLinesRemaining -= Math.min(outputLinesRemaining, countLines(content))
            }
            const serialized = this.redactor.redact(formatEvent(event, outputLineLimit))
            if (size + serialized.length > budget) {
                omitted += index + 1
                break
            }
            selected.push(serialized)
            size += serialized.length
        }
        if (omitted) {
            selected.push(`[MODEL CONTEXT: ${omitted} older event(s) omitted; the permanent local JSONL history is unchanged.]`)
        }
        return selected.reverse().join('\n')
    }
}

function formatEvent (event: SessionEvent, outputLineLimit?: number): string {
    const data = event.data as any
    switch (event.type) {
        case 'user-ai-input':
            return `USER: ${data.content}`
        case 'ssh-input':
            return `SSH COMMAND (${data.source ?? 'unknown'}): ${data.content}`
        case 'ssh-output':
            return `SSH OUTPUT: ${truncateOutput(data.content, outputLineLimit)}`
        case 'ai-message':
            return `AI: ${data.content}`
        case 'ai-command':
            return `AI COMMAND [${data.risk ?? 'unknown'}]: ${data.command}`
        case 'approval':
            return `USER APPROVAL: ${JSON.stringify(data)}`
        case 'summary':
            return `SUMMARY: ${data.content}`
        case 'error':
            return `ERROR: ${data.message}`
        default:
            return `${event.type.toUpperCase()}: ${JSON.stringify(data)}`
    }
}

function truncateOutput (content: string, maximumLines = Number.MAX_SAFE_INTEGER): string {
    const maximum = 12000
    const lines = content.split(/\r?\n/)
    const lineLimited = lines.length > maximumLines
        ? `[EARLIER OUTPUT LINES OMITTED]\n${lines.slice(-maximumLines).join('\n')}`
        : content
    if (lineLimited.length <= maximum) {
        return lineLimited
    }
    const half = maximum / 2
    return `${lineLimited.substring(0, half)}\n[OUTPUT TRUNCATED]\n${lineLimited.substring(lineLimited.length - half)}`
}

function countLines (content: string): number {
    return content ? content.split(/\r?\n/).length : 0
}
