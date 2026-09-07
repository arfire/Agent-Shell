import { Injectable } from '@angular/core'

import { ChatMessage } from '../llm/chat-completions.client'
import { AIConfigService } from '../config/ai-config.service'
import { SecretRedactor } from '../policy/secret-redactor'
import { AISessionRuntime } from '../session/ai-session.service'
import { SessionEvent } from '../session/session-event'

const SYSTEM_PROMPT = `You are an AI operations agent embedded in an SSH terminal.
Work only in the current SSH session. Use terminal_exec to inspect, change, and verify the server.
History may come from a previous SSH connection or a different server. The current SSH session header is the execution target. Recheck relevant environment state before continuing a historical task. Historical approvals are not current authorization; previously recorded sensitive placeholders have no restored secret value and must be requested again when needed.
Use request_user_input when required information is missing. Use kind "secret" for passwords, tokens, private endpoints and other sensitive values; the returned placeholder can be used verbatim in terminal_exec and is expanded only on the local machine.
Values named __TABBY_SENSITIVE_N__ are opaque local placeholders. Never alter, expand, guess or quote their hidden contents.
Execute one command step at a time, observe its output and exit code, then decide the next step.
Use the current shell's syntax, including when the shell is Fish or PowerShell.
Keep commands focused. When a combined command is long, format it over multiple lines with readable indentation and shell-safe continuations after operators such as &&, || and |.
Do not combine unrelated operations merely to reduce the number of tool calls.
Never claim success without verification. Never invent command output.
Treat unfamiliar products, packages, repositories, services and command names as unverified.
Never infer an unfamiliar item's vendor, ecosystem, package manager, repository or installation method from its name.
Before installing or modifying anything, establish the target's identity and source from user-provided information or authoritative evidence.
Never read known credential files such as .env, SSH keys, cloud credentials, Docker credentials or Kubernetes credentials. Ask for only the required value with request_user_input(kind="secret").
Treat reads of general configuration files as potentially sensitive and explain exactly which fields are needed.
If the identity or authoritative source is ambiguous, stop and ask the user for an official URL, repository, vendor or documentation.
Never use install, update or executable download commands to discover whether a package exists. Discovery must be read-only.
Clearly label hypotheses as unverified. Never present a guess as a fact or take action based on it.
A failed or slow request does not prove the server location, firewall state or cause of failure. Report only what the evidence establishes.
Every network command must use both a connection timeout and a total timeout when the command supports them.
The local policy engine, not you, determines approval requirements.
If the user asks for analysis only or says not to execute, do not call tools.
Keep user-facing explanations concise and describe the reason for every command.
Your output is rendered in the same terminal as the shell. Use concise paragraphs and lightweight Markdown: ATX headings, **bold**, *italic*, lists, blockquotes, inline code and fenced code blocks. Links remain literal text. Avoid HTML, terminal control sequences, chat decorations, images and large tables.`

@Injectable({ providedIn: 'root' })
export class AgentContextBuilder {
    constructor (
        private redactor: SecretRedactor,
        private config: AIConfigService,
    ) { }

    build (
        runtime: AISessionRuntime,
        input: string,
        maxTokens: number,
        protect: (content: string) => string = content => this.redactor.redact(content),
    ): ChatMessage[] {
        const profile = runtime.tab.profile
        const header = {
            host: profile.options.host,
            port: profile.options.port,
            user: profile.options.user,
            profile: profile.name,
            shell: runtime.shellKind ?? 'unknown',
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
                content: protect(`Current SSH session:\n${JSON.stringify(header)}\nRecent session timeline:\n${history}`),
            },
            { role: 'user', content: protect(input) },
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
