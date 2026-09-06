import { TerminalTextFilter } from './terminal-text'

const RESET = '\x1b[0m'

/** A bounded, append-only Markdown subset. Never buffers or reparses a response.
 * Ambiguous prefixes retain at most 32 characters; text streams immediately.
 * Links, tables and HTML remain literal text. Only locally generated SGR is used.
 */
export class TerminalMarkdown {
    private sanitizer = new TerminalTextFilter()
    private prefix = ''
    private startingLine = true
    private fence = ''
    private fenceLine = false
    private heading = false
    private quote = false
    private bold = false
    private italic = false
    private strike = false
    private code = false
    private delimiter = ''

    feed (input: string): string {
        const initialStyle = this.style()
        let output = ''
        for (const character of this.sanitizer.feed(input)) {
            if (character === '\r') { continue }
            if (this.fenceLine) {
                if (character === '\n') {
                    this.fenceLine = false
                    this.startingLine = true
                }
                continue
            }
            if (this.startingLine) {
                this.prefix += character
                const fence = /^ {0,3}(`{3}|~{3})$/.exec(this.prefix)
                if (fence && (!this.fence || this.fence === fence[1])) {
                    this.fence = this.fence ? '' : fence[1]
                    this.code = false
                    this.prefix = ''
                    this.fenceLine = true
                    output += this.style()
                    continue
                }
                if (!this.fence) {
                    if (/^ {0,3}#{1,6} $/.test(this.prefix)) {
                        this.heading = true
                        this.startingLine = false
                        this.prefix = ''
                        output += this.style()
                        continue
                    }
                    if (/^ {0,3}> $/.test(this.prefix)) {
                        this.quote = true
                        this.startingLine = false
                        this.prefix = ''
                        output += this.style() + '│ '
                        continue
                    }
                    const list = /^( *)([-+*]|\d{1,9}[.)]) $/.exec(this.prefix)
                    if (list) {
                        this.startingLine = false
                        this.prefix = ''
                        output += list[1] + (list[2].length === 1 ? '•' : list[2]) + ' '
                        continue
                    }
                }
                const candidate = this.fence
                    ? /^ {0,3}(?:`{0,2}|~{0,2})$/.test(this.prefix)
                    : /^(?: {0,31}| {0,3}(?:#{1,6}|>{1}|`{1,2}|~{1,2})| {0,24}(?:[-+*]|\d{1,9}[.)]?))$/.test(this.prefix)
                if (candidate && character !== '\n' && this.prefix.length < 32) { continue }
                this.startingLine = false
                const prefix = this.prefix
                this.prefix = ''
                for (const part of prefix) { output += this.character(part) }
            } else {
                output += this.character(character)
            }
        }
        return output ? initialStyle + output + RESET : ''
    }

    finish (): string {
        // Preserve incomplete syntax literally; no repaint of earlier terminal history.
        const tail = this.delimiter + this.prefix
        this.delimiter = ''
        this.prefix = ''
        return tail ? this.style() + tail + RESET : ''
    }

    private character (character: string): string {
        if (character === '\n') {
            const pending = this.delimiter
            this.delimiter = ''
            this.startingLine = true
            this.heading = false
            this.quote = false
            this.bold = false
            this.italic = false
            this.strike = false
            this.code = false
            return pending + '\r\n' + this.style()
        }
        if (this.fence) { return character }
        if (this.code) {
            if (character === '`') { this.code = false; return this.style() }
            return character
        }
        let output = ''
        if (this.delimiter) {
            const delimiter = this.delimiter
            this.delimiter = ''
            if (delimiter === '\\') {
                return /[\\`*{}\[\]()#+.!_>~-]/.test(character) ? character : '\\' + character
            }
            if (delimiter === '*' && character === '*') {
                this.bold = !this.bold
                return this.style()
            }
            if (delimiter === '~' && character === '~') {
                this.strike = !this.strike
                return this.style()
            }
            if (delimiter === '*') {
                this.italic = !this.italic
                output += this.style()
            } else {
                output += delimiter
            }
        }
        if (character === '*' || character === '~' || character === '\\') {
            this.delimiter = character
        } else if (character === '`') {
            this.code = true
            output += this.style()
        } else {
            output += character
        }
        return output
    }

    private style (): string {
        // Theme palette colors remain legible with both light and dark terminal themes.
        const attributes = ['0', this.fence || this.code ? '39' : '36']
        if (this.heading || this.bold) { attributes.push('1') }
        if (this.italic) { attributes.push('3') }
        if (this.strike) { attributes.push('9') }
        if (this.quote) { attributes.push('2') }
        return '\x1b[' + attributes.join(';') + 'm'
    }
}

export function terminalMarkdown (text: string): string {
    const renderer = new TerminalMarkdown()
    return renderer.feed(text) + renderer.finish()
}
