import { Injectable } from '@angular/core'
import * as crypto from 'crypto'
import { AIConfig } from '../config/config-schema'
import { AIRequestError, ChatCompletionsClient, ChatCompletionResult, ChatMessage, ChatTool } from './chat-completions.client'

export interface ModelCheck {
    id: string
    label: string
    state: 'pending'|'running'|'passed'|'failed'|'skipped'|'cancelled'
    message: string
}

@Injectable({ providedIn: 'root' })
export class ModelCompatibilityService {
    constructor (private client: ChatCompletionsClient) { }

    async check (settings: AIConfig['llm'], update: (checks: ModelCheck[]) => void, signal: AbortSignal): Promise<ModelCheck[]> {
        const checks: ModelCheck[] = [
            { id: 'reply', label: '普通回复', state: 'pending', message: '' },
            { id: 'stream', label: '流式输出', state: 'pending', message: '' },
            { id: 'tools', label: '工具调用', state: 'pending', message: '' },
            { id: 'result', label: '结果回传', state: 'pending', message: '' },
        ]
        const emit = (): void => update(checks.map(check => ({ ...check })))
        const state = { blocked: false }
        const run = async (index: number, action: () => Promise<void>): Promise<void> => {
            const check = checks[index]
            if (signal.aborted || state.blocked) {
                check.state = signal.aborted ? 'cancelled' : 'skipped'
                check.message = signal.aborted ? '已取消' : '请先解决地址或认证问题'
                emit()
                return
            }
            check.state = 'running'
            emit()
            try {
                await action()
                signal.throwIfAborted()
                check.state = 'passed'
                check.message = '通过'
            } catch (error) {
                check.state = this.cancelled(signal) ? 'cancelled' : 'failed'
                check.message = this.cancelled(signal) ? '已取消' : this.describe(error, settings.apiKey)
                state.blocked = error instanceof AIRequestError && [401, 403, 404].includes(error.status)
            }
            emit()
        }
        emit()
        await run(0, async () => {
            const reply = await this.client.testConnection(settings, signal)
            if (!reply.content) { throw new Error('接口有响应，但没有返回文字，请确认所选模型支持普通回复') }
        })
        await run(1, async () => {
            const reply = await this.client.stream([
                { role: 'system', content: 'This is a connection check. Reply concisely.' },
                { role: 'user', content: 'Reply with OK.' },
            ], [], {}, signal, settings)
            if (!reply.content.trim()) { throw new Error('未收到流式文字，请确认接口和模型支持流式回答') }
        })
        const tools: ChatTool[] = [{ type: 'function', 'function': {
            name: 'ash_connection_check',
            description: 'A simulated connection check. Does not execute any command or access any server.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        } }]
        const messages: ChatMessage[] = [
            { role: 'system', content: 'This is a tool compatibility check. Follow the user instructions exactly.' },
            { role: 'user', content: 'Call ash_connection_check exactly once with text "ash-check". After receiving its result, repeat its value verbatim and do not call another tool.' },
        ]
        const toolState: { reply?: ChatCompletionResult } = {}
        await run(2, async () => {
            const reply = await this.client.stream(messages, tools, {}, signal, settings)
            const call = reply.toolCalls[0]
            if (reply.toolCalls.length !== 1 || !call.id || call.function.name !== 'ash_connection_check') {
                throw new Error('未收到预期的工具调用。请确认模型支持 tools 和 tool_choice: auto，或重试检查')
            }
            let args: any = null
            try { args = JSON.parse(call.function.arguments) } catch { throw new Error('工具参数不是有效 JSON，请检查服务的流式工具调用格式') }
            if (args?.text !== 'ash-check') { throw new Error('模型返回的工具参数与检查要求不符，请重试或更换模型') }
            toolState.reply = reply
        })
        if (toolState.reply) {
            const reply = toolState.reply
            await run(3, async () => {
                const value = `ASH_OK_${crypto.randomBytes(8).toString('hex')}`
                const result = await this.client.stream([
                    ...messages,
                    { role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls },
                    { role: 'tool', tool_call_id: reply.toolCalls[0].id, content: JSON.stringify({ value }) },
                ], tools, {}, signal, settings)
                if (!result.content.includes(value) || result.toolCalls.length) {
                    throw new Error('模型没有正确读取工具结果，请重试或确认服务支持 tool 消息回传')
                }
            })
        } else {
            checks[3].state = signal.aborted ? 'cancelled' : 'skipped'
            checks[3].message = signal.aborted ? '已取消' : '工具调用通过后才能检查结果回传'
            emit()
        }
        return checks.map(check => ({ ...check }))
    }

    private cancelled (signal: AbortSignal): boolean { return signal.aborted }

    private describe (error: unknown, apiKey: string): string {
        if (error instanceof AIRequestError) {
            if (error.status === 401) { return '认证失败：请检查 API Key 是否正确或已过期（401）' }
            if (error.status === 403) { return '访问被拒绝：请检查账号、模型使用权限或服务访问限制（403）' }
            if (error.status === 404) { return '地址或模型不存在：检查基础地址和模型名称，不要重复填写 /chat/completions（404）' }
            if (error.status === 429) { return '服务限流或额度不足，请检查额度并稍后重试（429）' }
            if (error.status >= 500) { return `模型服务暂时异常，请稍后重试（${error.status}）` }
            if ([400, 422].includes(error.status)) {
                const message = apiKey ? error.message.split(apiKey).join('[已隐藏]') : error.message
                return `模型或参数不兼容，请检查 temperature、stream 和 tools 的支持情况。${message}`
            }
        }
        const message = error instanceof Error ? error.message : String(error)
        if (/timed out|timeout/i.test(message)) { return '请求超时，可检查网络或调大模型连接页的超时时间' }
        if (/fetch failed|Failed to fetch|NetworkError/i.test(message)) { return '无法连接模型服务，请检查地址、网络和代理设置' }
        return apiKey ? message.split(apiKey).join('[已隐藏]') : message
    }
}
