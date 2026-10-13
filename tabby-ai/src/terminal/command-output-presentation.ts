import { TerminalTextFilter } from './terminal-text'

/** Only Ash generates cursor controls. Remote ANSI/OSC strings are stripped. */
export class CommandOutputPresentation {
    private filter = new TerminalTextFilter(true)
    private line = ''
    private progress = false
    private carriage = false
    private rewrites = false

    feed (text: string, columns = 80): string {
        let output = ''
        const update = (): string => {
            this.progress = true
            // One physical row remains safe to repaint after terminal resizing.
            return '\r\x1b[2K' + this.line.slice(0, Math.max(1, columns - 1))
        }
        for (const character of this.filter.feed(text)) {
            if (character === '\r') {
                this.carriage = true
            } else if (character === '\n') {
                const dockerProgress = /^\s*[a-f0-9]{12,64}:?\s+(?:Downloading|Extracting|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists|Pulling fs layer)\b/.test(this.line)
                if (dockerProgress) {
                    output += update()
                } else if (this.rewrites) {
                    output += update() + '\r\n'
                    this.progress = false
                } else {
                    if (this.progress) { output += '\r\n' }
                    output += this.line + '\r\n'
                    this.progress = false
                }
                this.line = ''
                this.carriage = false
                this.rewrites = false
            } else {
                if (this.carriage) {
                    output += update()
                    this.line = ''
                    this.carriage = false
                    this.rewrites = true
                }
                this.line += character
                if (this.line.length >= 16384) {
                    output += (this.progress ? '\r\n' : '') + this.line
                    this.line = ''
                    this.progress = false
                }
            }
        }
        return output
    }

    finish (): string {
        const output = this.rewrites ? '\r\x1b[2K' + this.line + '\r\n'
            : (this.progress ? '\r\n' : '') + this.line
        this.line = ''
        this.progress = false
        this.carriage = false
        this.rewrites = false
        return output
    }
}
