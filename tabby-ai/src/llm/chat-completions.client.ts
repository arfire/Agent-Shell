import { Injectable } from '@angular/core'

import { AIConfigService } from '../config/ai-config.service'
import { AIConfig } from '../config/config-schema'

export interface ChatMessage {
    role: 'system'|'user'|'assistant'|'tool'
    content: string|null
    name?: string
    tool_call_id?: string
    tool_calls?: ToolCall[]
}

export interface ToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

export interface ChatTool {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: Record<string, unknown>
    }
}

export interface StreamHandlers {
    onText?: (text: string) => void
    onToolCallDelta?: (toolCall: ToolCall) => void
}

export interface ChatCompletionResult {
    content: string
    toolCalls: ToolCall[]
    finishReason: string|null
}

export interface ConnectionTestResult {
    model: string
    content: string
}

@Injectable({ providedIn: 'root' })
export class ChatCompletionsClient {
    constructor (private configService: AIConfigService) { }

    async stream (
        messages: ChatMessage[],
        tools: ChatTool[],
        handlers: StreamHandlers,
        signal?: AbortSignal,
    ): Promise<ChatCompletionResult> {
        const config = this.configService.config.llm
        if (!config.model) {
            throw new Error('No AI model is configured')
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('AI request timed out')), config.timeout)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        try {
            const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: config.model,
                    messages,
                    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
                    temperature: config.temperature,
                    stream: true,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                const detail = await response.text()
                throw new Error(`AI request failed (${response.status}): ${detail.slice(0, 1000)}`)
            }
            if (!response.body) {
                throw new Error('AI response did not contain a stream')
            }
            return await this.consumeStream(response.body, handlers)
        } finally {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', abort)
        }
    }

    async testConnection (settings: AIConfig['llm'], signal?: AbortSignal): Promise<ConnectionTestResult> {
        if (!settings.baseURL.trim()) {
            throw new Error('API Base URL is required')
        }
        if (!settings.model) {
            throw new Error('Model is required')
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('Connection test timed out')), settings.timeout)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        try {
            const response = await fetch(`${settings.baseURL.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: settings.model,
                    messages: [{ role: 'user', content: 'Reply with OK.' }],
                    temperature: 0,
                    stream: false,
                    max_tokens: 8,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                throw new Error(`Connection test failed (${response.status}): ${(await response.text()).slice(0, 500)}`)
            }
            const data = await response.json()
            const choice = data?.choices?.[0]
            if (!choice?.message) {
                throw new Error('The endpoint returned HTTP 200 but no Chat Completions message')
            }
            return {
                model: String(data.model ?? settings.model),
                content: String(choice.message.content ?? '').trim(),
            }
        } finally {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', abort)
        }
    }

    private async consumeStream (body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<ChatCompletionResult> {
        const reader = body.getReader()
        const decoder = new TextDecoder()
        const toolCalls = new Map<number, ToolCall>()
        let pending = ''
        let content = ''
        let finishReason: string|null = null

        while (true) {
            const { done, value } = await reader.read()
            pending += decoder.decode(value, { stream: !done })
            const lines = pending.split(/\r?\n/)
            pending = lines.pop() ?? ''
            for (const line of lines) {
                if (!line.startsWith('data:')) {
                    continue
                }
                const data = line.substring(5).trim()
                if (!data || data === '[DONE]') {
                    continue
                }
                const chunk = JSON.parse(data)
                const choice = chunk.choices?.[0]
                if (!choice) {
                    continue
                }
                finishReason = choice.finish_reason ?? finishReason
                const delta = choice.delta ?? {}
                if (delta.content) {
                    content += delta.content
                    handlers.onText?.(delta.content)
                }
                for (const item of delta.tool_calls ?? []) {
                    const index = item.index ?? 0
                    const current = toolCalls.get(index) ?? {
                        id: '',
                        type: 'function' as const,
                        function: { name: '', arguments: '' },
                    }
                    current.id += item.id ?? ''
                    current.function.name += item.function?.name ?? ''
                    current.function.arguments += item.function?.arguments ?? ''
                    toolCalls.set(index, current)
                    handlers.onToolCallDelta?.({
                        ...current,
                        function: { ...current.function },
                    })
                }
            }
            if (done) {
                break
            }
        }
        return { content, toolCalls: [...toolCalls.values()], finishReason }
    }
}
