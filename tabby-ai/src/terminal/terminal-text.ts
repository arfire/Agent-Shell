/** Streaming control-sequence filter. Never pass model-provided terminal commands. */
export class TerminalTextFilter {
    private state: 'text'|'escape'|'csi'|'string'|'string-escape' = 'text'
    private carriageReturn = false

    feed (text: string): string {
        let result = ''
        for (const character of text) {
            const code = character.codePointAt(0)!
            if (this.state === 'string-escape') {
                this.state = character === '\\' ? 'text' : 'string'
                continue
            }
            if (this.state === 'string') {
                if (character === '\x1b') {
                    this.state = 'string-escape'
                } else if (character === '\x07' || character === '\x9c') {
                    this.state = 'text'
                }
                continue
            }
            if (this.state === 'csi') {
                if (code >= 0x40 && code <= 0x7e) {
                    this.state = 'text'
                }
                continue
            }
            if (this.state === 'escape') {
                if (character === '[') {
                    this.state = 'csi'
                } else if (']PX^_'.includes(character)) {
                    this.state = 'string'
                } else if (code >= 0x30 && code <= 0x7e) {
                    this.state = 'text'
                }
                continue
            }
            if (character === '\x1b') {
                this.state = 'escape'
            } else if (character === '\x9b') {
                this.state = 'csi'
            } else if ('\x90\x98\x9d\x9e\x9f'.includes(character)) {
                this.state = 'string'
            } else if (character === '\r' || character === '\n') {
                if (character !== '\n' || !this.carriageReturn) {
                    result += '\r\n'
                }
                this.carriageReturn = character === '\r'
                continue
            } else if (character === '\t') {
                result += '    '
            } else if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) {
                result += character
            }
            this.carriageReturn = false
        }
        return result
    }
}

export function terminalText (text: string): string {
    return new TerminalTextFilter().feed(text)
}
