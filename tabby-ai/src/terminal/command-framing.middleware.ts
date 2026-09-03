import { StringDecoder } from 'string_decoder'
import * as crypto from 'crypto'
import { SessionMiddleware } from 'tabby-terminal'

import { AIInputMiddleware } from './ai-input.middleware'
import { detectInteractivePrompt, InteractivePromptKind } from './interactive-prompt'

interface PendingCommand {
    beginMarker: string
    marker: string
    beginPattern: RegExp
    pattern: RegExp
    buffer: string
    output: string
    resolve: (result: CommandExecutionResult) => void
    reject: (error: Error) => void
    input: AIInputMiddleware
    onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>
    promptActive: boolean
    started: boolean
    signal?: AbortSignal
    abortHandler?: () => void
    outputFilter?: (content: string) => string
}

export { InteractivePromptKind } from './interactive-prompt'

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
        if (!pending.started) {
            const begin = pending.beginPattern.exec(pending.buffer)
            if (!begin) {
                return
            }
            pending.buffer = pending.buffer.substring(begin.index + begin[0].length)
            pending.started = true
        }
        this.detectPrompt(pending)
        const match = pending.pattern.exec(pending.buffer)
        if (match) {
            const before = pending.buffer.substring(0, match.index)
            const after = pending.buffer.substring(match.index + match[0].length)
            this.emitVisible(pending, before)
            if (after) {
                this.outputToTerminal.next(Buffer.from(after, 'utf8'))
            }
            this.pending = null
            this.removeAbortHandler(pending)
            pending.resolve({ output: pending.output, exitCode: Number(match[1]) })
            return
        }

        const tailLength = pending.marker.length + 32
        if (pending.buffer.length > tailLength) {
            const safe = pending.buffer.substring(0, pending.buffer.length - tailLength)
            pending.buffer = pending.buffer.substring(pending.buffer.length - tailLength)
            this.emitVisible(pending, safe)
        }
    }

    feedFromTerminal (data: Buffer): void {
        if (this.pending && data.length === 1 && data[0] === 3) {
            this.cancel(new DOMException('Command interrupted by user', 'AbortError'))
            return
        }
        this.outputToSession.next(data)
    }

    execute (
        command: string,
        input: AIInputMiddleware,
        onPrompt?: (prompt: string, kind: InteractivePromptKind) => Promise<string|null>,
        signal?: AbortSignal,
        outputFilter?: (content: string) => string,
    ): Promise<CommandExecutionResult> {
        if (this.pending) {
            return Promise.reject(new Error('Another AI command is already running in this terminal'))
        }
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new DOMException('Agent stopped', 'AbortError'))
        }
        const nonce = crypto.randomUUID().replaceAll('-', '')
        const beginMarker = `__TABBY_AI_BEGIN_${nonce}`
        const marker = `__TABBY_AI_END_${nonce}`
        return new Promise((resolve, reject) => {
            const pending: PendingCommand = {
                beginMarker,
                marker,
                beginPattern: new RegExp(`${beginMarker}\\r?\\n`),
                pattern: new RegExp(`${marker}:(-?\\d+)\\r?\\n?`),
                buffer: '',
                output: '',
                resolve,
                reject,
                input,
                onPrompt,
                promptActive: false,
                started: false,
                signal,
                outputFilter,
            }
            pending.abortHandler = () => this.cancel(signal?.reason)
            signal?.addEventListener('abort', pending.abortHandler, { once: true })
            this.pending = pending
            const encoded = Buffer.from(command, 'utf8').toString('base64')
            const wrapped = `printf '\\n${beginMarker}\\n'; __tabby_ai_cmd=$(printf '%s' '${encoded}' | base64 -d); eval "$__tabby_ai_cmd"; __tabby_ai_exit=$?; printf '\\n${marker}:%s\\n' "$__tabby_ai_exit"; unset __tabby_ai_cmd __tabby_ai_exit\n`
            input.sendAgent(wrapped)
        })
    }

    cancel (reason?: unknown): void {
        if (!this.pending) {
            return
        }
        const pending = this.pending
        this.pending = null
        this.removeAbortHandler(pending)
        if (pending.started && pending.buffer) {
            this.emitVisible(pending, this.stripPartialEndMarker(pending))
            pending.buffer = ''
        }
        pending.input.sendAgent(Buffer.from([3]))
        pending.reject(reason instanceof Error ? reason : new DOMException('Agent stopped', 'AbortError'))
    }

    close (): void {
        if (this.pending) {
            const pending = this.pending
            this.pending = null
            this.removeAbortHandler(pending)
            if (pending.started && pending.buffer) {
                this.emitVisible(pending, this.stripPartialEndMarker(pending))
            }
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
        if (!detected) {
            return
        }
        pending.promptActive = true
        // The marker safety tail normally delays short chunks. Show the
        // actual prompt before opening the form so the terminal and form stay
        // visually in sync.
        if (pending.buffer) {
            this.emitVisible(pending, pending.buffer)
            pending.buffer = ''
        }
        void pending.onPrompt(detected.prompt, detected.kind)
            .then(value => {
                if (value !== null && this.pending === pending) {
                    pending.input.sendAgent(`${value}\n`)
                }
            })
            .catch(error => {
                if (this.pending === pending) {
                    this.cancel(error)
                }
            })
            .finally(() => {
                pending.promptActive = false
            })
    }

    private removeAbortHandler (pending: PendingCommand): void {
        if (pending.signal && pending.abortHandler) {
            pending.signal.removeEventListener('abort', pending.abortHandler)
        }
    }

    private emitVisible (pending: PendingCommand, content: string): void {
        if (!content) {
            return
        }
        const visible = pending.outputFilter?.(content) ?? content
        pending.output += visible
        if (visible) {
            this.outputToTerminal.next(Buffer.from(visible, 'utf8'))
        }
    }

    private stripPartialEndMarker (pending: PendingCommand): string {
        const markerStart = pending.buffer.indexOf(pending.marker)
        return markerStart === -1 ? pending.buffer : pending.buffer.substring(0, markerStart)
    }
}
