/** Clipboard line endings do not depend on the local OS. Terminal Enter is CR. */
export function normalizePaste (text: string, alternateScreen: boolean, replaceNewlines: boolean): string {
    const normalized = text.replace(/\r\n|\n/g, '\r')
    return !alternateScreen && replaceNewlines ? normalized.replace(/\r+/g, ' ') : normalized
}
