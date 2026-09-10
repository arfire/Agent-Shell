import { SessionEvent } from '../session/session-event'
import { terminalText, TerminalTextFilter } from './terminal-text'
import { terminalMarkdown } from './terminal-markdown'

/** Historical data is text, never executable terminal protocol. */
export function * historyChunks (events: SessionEvent[]): Generator<string> {
    const output = new TerminalTextFilter()
    for (const event of events) {
        const data = event.data as Record<string, unknown>
        if (event.type === 'ssh-output') {
            yield output.feed(String(data.content ?? ''))
            continue
        }
        if (event.type === 'user-ai-input') {
            yield '\r\n你 › ' + terminalText(String(data.content ?? '')) + '\r\n'
        } else if (event.type === 'ai-message') {
            yield '\r\n\x1b[36mAgent\x1b[0m\r\n' + terminalMarkdown(String(data.content ?? '')) + '\r\n'
        } else if (event.type === 'ssh-input') {
            yield '\r\n$ ' + terminalText(String(data.content ?? '')) + '\r\n'
        } else if (event.type === 'command-result') {
            yield '\r\n\x1b[2m退出状态：' + terminalText(String(data.exitCode ?? '未知')) + '\x1b[0m\r\n'
        } else if (event.type === 'web-activity') {
            yield '\r\n联网: ' + terminalText(String(data.content ?? '')) + '\r\n'
        } else if (event.type === 'error') {
            yield '\r\nAgent: ' + terminalText(String(data.message ?? '')) + '\r\n'
        }
    }
}
