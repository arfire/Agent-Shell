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

export class AIRequestError extends Error {
    constructor (public status: number, detail: string) {
        super(`AI request failed (${status}): ${detail.slice(0, 500)}`)
    }
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
        settings?: AIConfig['llm'],
    ): Promise<ChatCompletionResult> {
        const config = settings ?? this.configService.config.llm
        if (!config.model) {
            throw new Error('No AI model is configured')
        }
        signal?.throwIfAborted()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('AI request timed out')), config.timeout)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        try {
            const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
                },
                body: JSON.stringify({
                    model: config.model,
                    messages,
                    ...tools.length ? { tools, tool_choice: 'auto' } : {},
                    temperature: config.temperature,
                    stream: true,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                const detail = await response.text()
                throw new AIRequestError(response.status, detail)
            }
            const contentType = response.headers.get('content-type')
            if (contentType && !/^text\/event-stream\b/i.test(contentType)) {
                throw new Error('接口未返回 SSE 流式回答，请检查模型服务的流式支持')
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
        signal?.throwIfAborted()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('Connection test timed out')), settings.timeout)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        try {
            const response = await fetch(`${settings.baseURL.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
                },
                body: JSON.stringify({
                    model: settings.model,
                    messages: [{ role: 'user', content: 'Reply with OK.' }],
                    temperature: settings.temperature,
                    stream: false,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                throw new AIRequestError(response.status, await response.text())
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

    async listModels (settings: AIConfig['llm'], signal?: AbortSignal): Promise<string[]> {
        if (!settings.baseURL.trim()) {
            throw new Error('API Base URL is required')
        }
        signal?.throwIfAborted()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('Model list request timed out')), settings.timeout)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        try {
            const response = await fetch(`${settings.baseURL.replace(/\/$/, '')}/models`, {
                method: 'GET',
                headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
                signal: controller.signal,
            })
            if (!response.ok) {
                throw new Error(`Model list request failed (${response.status}): ${(await response.text()).slice(0, 500)}`)
            }
            const data = await response.json()
            if (!Array.isArray(data?.data)) {
                throw new Error('The /models response does not contain a data array')
            }
            const modelIds = data.data
                .map((item: unknown): string|null => {
                    if (typeof item === 'string') {
                        return item
                    }
                    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
                        return item.id
                    }
                    return null
                })
                .filter((id: string|null): id is string => typeof id === 'string' && !!id.trim())
            return [...new Set<string>(modelIds)]
                .sort((a, b) => a.localeCompare(b))
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
        let eventData: string[] = []
        let content = ''
        const state: { finishReason: string|null, completed: boolean } = { finishReason: null, completed: false }
        const isComplete = (): boolean => state.completed
        const event = (): void => {
            const data = eventData.join('\n').trim()
            eventData = []
            if (!data) { return }
            if (data === '[DONE]') { state.completed = true; return }
            let chunk: any = null
            try { chunk = JSON.parse(data) } catch { throw new Error('模型返回的流式数据不是有效 JSON') }
            if (chunk?.error) { throw new Error('模型在流式回答中返回错误，请检查服务端状态或参数兼容性') }
            const choice = chunk?.choices?.[0]
            if (!choice) { return }
            state.finishReason = choice.finish_reason ?? state.finishReason
            const delta = choice.delta ?? {}
            if (typeof delta.content === 'string' && delta.content) {
                content += delta.content
                handlers.onText?.(delta.content)
            }
            for (const item of delta.tool_calls ?? []) {
                const index = item.index ?? 0
                const current = toolCalls.get(index) ?? { id: '', type: 'function' as const, 'function': { name: '', arguments: '' } }
                current.id += item.id ?? ''
                current.function.name += item.function?.name ?? ''
                current.function.arguments += item.function?.arguments ?? ''
                toolCalls.set(index, current)
                handlers.onToolCallDelta?.({ ...current, 'function': { ...current.function } })
            }
        }
        const line = (value: string): void => {
            if (!value) { event() } else if (value.startsWith('data:')) { eventData.push(value.slice(5).replace(/^ /, '')) }
        }
        try {
            while (!state.completed) {
                const { done, value } = await reader.read()
                pending += decoder.decode(value, { stream: !done })
                const lines = pending.split(/\r?\n/)
                pending = lines.pop() ?? ''
                for (const textLine of lines) {
                    line(textLine)
                    // The line handler can receive [DONE] and update state.
                    if (isComplete()) { break }
                }
                if (done) {
                    if (pending) { line(pending) }
                    event()
                    break
                }
            }
            if (!state.completed && !state.finishReason) { throw new Error('模型回答意外中断，未收到结束标记，请重试') }
            if (!content && !toolCalls.size) { throw new Error('接口没有返回文字或工具调用，请检查协议和模型名称') }
            return { content, toolCalls: [...toolCalls.values()], finishReason: state.finishReason }
        } finally {
            await reader.cancel().catch(() => undefined)
            reader.releaseLock()
        }
    }
}
