/** A text transcript is not a terminal recording. Omit alternate-screen programs
 * and apply line editing before saving/displaying the remaining shell output. */
export class TerminalHistoryFilter {
    private escape = ''
    private string = false
    private stringEscape = false
    private alternate = new Set<number>()
    private line: string[] = []
    private cursor = 0

    feed (text: string): string {
        let output = ''
        for (const character of text) {
            if (this.string) {
                if (character === '\x07' || character === '\x9c' || this.stringEscape && character === '\\') { this.string = false }
                this.stringEscape = character === '\x1b'
                continue
            }
            if (this.escape) {
                this.escape += character
                if (this.escape === '\x1b[') { continue }
                if (/^\x1b[\]PX^_]$/.test(this.escape)) {
                    this.escape = ''
                    this.string = true
                    continue
                }
                if (this.escape.startsWith('\x1b[')) {
                    if (!/[@-~]/.test(character)) { if (this.escape.length > 256) { this.escape = '' } continue }
                    output += this.control(this.escape)
                } else if (this.escape.length === 2 && /[ -/]/.test(character)) { continue }
                this.escape = ''
                continue
            }
            if (character === '\x1b') { this.escape = character; continue }
            if (character === '\x9b') { this.escape = '\x1b['; continue }
            if ('\x90\x98\x9d\x9e\x9f'.includes(character)) { this.string = true; continue }
            if (this.alternate.size) { continue }
            if (character === '\r') {
                this.cursor = 0
            } else if (character === '\n') {
                output += this.line.join('') + '\r\n'; this.line = []; this.cursor = 0
            } else if (character === '\b') {
                this.cursor = Math.max(0, this.cursor - 1)
            } else if (character === '\t') {
                const count = 8 - this.cursor % 8
                for (let index = 0; index < count; index++) { this.line[this.cursor++] = ' ' }
            } else if (character >= ' ' && !/[\x7f-\x9f]/.test(character)) {
                while (this.line.length < this.cursor) { this.line.push(' ') }
                this.line[this.cursor++] = character
                if (this.cursor >= 16384) { output += this.flush() }
            }
        }
        return output
    }

    private control (sequence: string): string {
        const mode = /^\x1b\[\?([\d;]+)([hl])$/.exec(sequence)
        if (mode) {
            let output = ''
            for (const value of mode[1].split(';').map(Number)) {
                if (![47, 1047, 1049].includes(value)) { continue }
                if (mode[2] === 'h') {
                    if (!this.alternate.size) { output += this.flush() + '[交互程序画面已省略]\r\n' }
                    this.alternate.add(value)
                } else { this.alternate.delete(value) }
            }
            return output
        }
        if (this.alternate.size) { return '' }
        const parameter = Number(sequence.slice(2, -1)) || 0
        const character = sequence.slice(-1)
        if (character === 'K') {
            if (parameter === 2) { this.line = [] } else if (parameter === 0) { this.line.length = this.cursor }
        } else if (character === 'G') {
            this.cursor = Math.min(16384, Math.max(0, parameter - 1))
        } else if (character === 'D') {
            this.cursor = Math.max(0, this.cursor - (parameter || 1))
        } else if (character === 'C') { this.cursor = Math.min(16384, this.cursor + (parameter || 1)) }
        return ''
    }

    flush (): string {
        const text = this.line.join('')
        this.line = []
        this.cursor = 0
        return text
    }

    peek (): string { return this.line.join('') }
}
