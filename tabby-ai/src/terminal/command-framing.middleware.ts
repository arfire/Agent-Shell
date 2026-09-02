import { StringDecoder } from 'string_decoder'
import * as crypto from 'crypto'
import { SessionMiddleware } from 'tabby-terminal'

import { AIInputMiddleware } from './ai-input.middleware'

interface PendingCommand {
    marker: string
    pattern: RegExp
    buffer: string
    output: string
    resolve: (result: CommandExecutionResult) => void
    reject: (error: Error) => void
    input: AIInputMiddleware
    onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>
    promptActive: boolean
    lastPrompt?: string
}

export type InteractivePromptKind = 'password'|'yes-no'|'text'

export interface CommandExecutionResult {
    output: string
    exitCode: number
}

export class CommandFramingMiddleware extends SessionMiddleware {
    private pending: PendingCommand|null = null
    private decoder = new StringDecoder('utf8')

    feedFromSession (data: Buffer): void {
        if (!this.pending) {
            this.outputToTerminal.next(data)
            return
        }
        const pending = this.pending
        pending.buffer += this.decoder.write(data)
        this.detectPrompt(pending)
        const match = pending.pattern.exec(pending.buffer)
        if (match) {
            const before = pending.buffer.substring(0, match.index)
            const after = pending.buffer.substring(match.index + match[0].length)
            pending.output += before
            if (before) {
                this.outputToTerminal.next(Buffer.from(before, 'utf8'))
            }
            if (after) {
                this.outputToTerminal.next(Buffer.from(after, 'utf8'))
            }
            this.pending = null
            pending.resolve({ output: pending.output, exitCode: Number(match[1]) })
            return
        }

        const tailLength = pending.marker.length + 32
        if (pending.buffer.length > tailLength) {
            const safe = pending.buffer.substring(0, pending.buffer.length - tailLength)
            pending.buffer = pending.buffer.substring(pending.buffer.length - tailLength)
            pending.output += safe
            this.outputToTerminal.next(Buffer.from(safe, 'utf8'))
        }
    }

    feedFromTerminal (data: Buffer): void {
        this.outputToSession.next(data)
    }

    execute (
        command: string,
        input: AIInputMiddleware,
        onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>,
    ): Promise<CommandExecutionResult> {
        if (this.pending) {
            return Promise.reject(new Error('Another AI command is already running in this terminal'))
        }
        const marker = `__TABBY_AI_END_${crypto.randomUUID().replaceAll('-', '')}`
        return new Promise((resolve, reject) => {
            this.pending = {
                marker,
                pattern: new RegExp(`${marker}:(-?\\d+)\\r?\\n?`),
                buffer: '',
                output: '',
                resolve,
                reject,
                input,
                onPrompt,
                promptActive: false,
            }
            const wrapped = `{\n${command}\n__tabby_ai_exit=$?\nprintf '\\n${marker}:%s\\n' "$__tabby_ai_exit"\n}\n`
            input.sendAgent(wrapped)
        })
    }

    close (): void {
        if (this.pending) {
            const pending = this.pending
            this.pending = null
            pending.reject(new Error('SSH session closed before the AI command completed'))
        }
        this.decoder.end()
        super.close()
    }

    private detectPrompt (pending: PendingCommand): void {
        if (!pending.onPrompt || pending.promptActive) {
            return
        }
        const tail = `${pending.output}${pending.buffer}`.slice(-1000)
        const detected = detectInteractivePrompt(tail)
        if (!detected || detected.prompt === pending.lastPrompt) {
            return
        }
        pending.lastPrompt = detected.prompt
        pending.promptActive = true
        void pending.onPrompt(detected.prompt, detected.kind).then(value => {
            if (value !== null && this.pending === pending) {
                pending.input.sendAgent(`${value}\n`)
            }
        }).finally(() => {
            pending.promptActive = false
        })
    }
}

function detectInteractivePrompt (content: string): { prompt: string, kind: InteractivePromptKind }|null {
    const password = /([^\r\n]*(?:password|passphrase|密码|口令)[^\r\n]{0,160}:)\s*$/i.exec(content)
    if (password) {
        return { prompt: password[1].trim(), kind: 'password' }
    }
    const yesNo = /([^\r\n]*(?:\[[Yy]\/\s*[Nn]\]|\[[Nn]\/\s*[Yy]\]|\([Yy]es\/[Nn]o\)|\([Nn]o\/[Yy]es\)|continue\?)[^\r\n]*)\s*$/i.exec(content)
    if (yesNo) {
        return { prompt: yesNo[1].trim(), kind: 'yes-no' }
    }
    const text = /([^\r\n]{2,200}(?:enter|input|select|choose|请输入|请选择)[^\r\n]*[:：])\s*$/i.exec(content)
    if (text) {
        return { prompt: text[1].trim(), kind: 'text' }
    }
    return null
}
