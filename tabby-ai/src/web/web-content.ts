import { parse } from 'parse5'
import { terminalText } from '../terminal/terminal-text'

interface HTMLNode {
    nodeName: string
    tagName?: string
    value?: string
    attrs?: { name: string, value: string }[]
    childNodes?: HTMLNode[]
}

const skipped = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'iframe', 'form'])
const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'li', 'pre', 'tr', 'br', 'hr'])

export function cleanWebText (value: string): string {
    return terminalText(value).replace(/\r\n/g, '\n').replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
}

/** Parse as data without a browser, script execution or subresource requests. */
export function extractWebContent (html: string, maximum: number): { title: string, content: string, truncated: boolean } {
    const document = parse(html) as HTMLNode
    let title = ''
    let main: HTMLNode|undefined = undefined
    let article: HTMLNode|undefined = undefined
    const pending = [document]
    while (pending.length) {
        const node = pending.pop()!
        if (node.tagName === 'title') { title = node.childNodes?.map(child => child.value ?? '').join('') ?? '' }
        if (node.tagName === 'main') { main ??= node }
        if (node.tagName === 'article') { article ??= node }
        if (!skipped.has(node.tagName ?? '')) { pending.push(...node.childNodes ?? []) }
    }
    const parts: string[] = []
    const queue = [{ node: main ?? article ?? document, pre: false }]
    while (queue.length) {
        const { node, pre } = queue.pop()!
        if (skipped.has(node.tagName ?? '') || node.attrs?.some(attr => attr.name === 'hidden' || attr.name === 'aria-hidden' && attr.value === 'true')) { continue }
        if (node.nodeName === '#text') { parts.push(pre ? node.value ?? '' : (node.value ?? '').replace(/\s+/g, ' ')) }
        if (blocks.has(node.tagName ?? '')) { parts.push('\n') }
        if (node.tagName === 'td' || node.tagName === 'th') { parts.push('\t') }
        if (node.childNodes) {
            queue.push({ node: { nodeName: '#text', value: blocks.has(node.tagName ?? '') ? '\n' : '' }, pre: true })
            for (let index = node.childNodes.length - 1; index >= 0; index--) {
                queue.push({ node: node.childNodes[index], pre: pre || node.tagName === 'pre' })
            }
        }
    }
    const text = cleanWebText(parts.join('')).replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim()
    return { title: cleanWebText(title).slice(0, 300), content: text.slice(0, maximum), truncated: text.length > maximum }
}
