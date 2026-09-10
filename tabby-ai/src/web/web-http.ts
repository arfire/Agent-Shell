import * as dns from 'dns'
import * as http from 'http'
import * as https from 'https'
import { BlockList, isIP } from 'net'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'

const blocked = new BlockList()
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) { blocked.addSubnet(address, prefix, 'ipv4') }
for (const [address, prefix] of [
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) { blocked.addSubnet(address, prefix, 'ipv6') }
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress (address: string): boolean {
    if (isIP(address) === 4) { return !blocked.check(address, 'ipv4') }
    return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export function webURL (value: string): URL {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('只支持不含用户名和密码的 HTTP/HTTPS 网页地址')
    }
    url.hash = ''
    return url
}

interface WebResponse {
    url: string
    status: number
    headers: http.IncomingHttpHeaders
    text: string
}

function requestOnce (url: URL, signal: AbortSignal, trusted: boolean, authorization: string): Promise<WebResponse> {
    return new Promise((resolve, reject) => {
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        if (!trusted && isIP(hostname) && !isPublicAddress(hostname)) {
            reject(new Error('网页读取不允许访问内网、回环或保留地址'))
            return
        }
        const headers: Record<string, string> = {
            Accept: 'application/json, text/html, text/plain;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'Ash-Web/1.0',
        }
        if (trusted && authorization) { headers.Authorization = authorization }
        const request = (url.protocol === 'https:' ? https : http).request(url, {
            method: 'GET', headers, agent: false, signal,
            // Resolve and validate in the socket lookup itself, preventing DNS rebinding.
            lookup: (name, options, callback) => {
                dns.lookup(name, { all: true }, (error, addresses) => {
                    if (error) { callback(new Error('域名解析失败'), '', 4); return }
                    if (!addresses.length || !trusted && addresses.some(item => !isPublicAddress(item.address))) {
                        callback(new Error('网页读取不允许访问内网、回环或保留地址'), '', 4)
                        return
                    }
                    if (options.all) { callback(null, addresses) } else { callback(null, addresses[0].address, addresses[0].family) }
                })
            },
        }, response => {
            const result = { url: url.href, status: response.statusCode ?? 0, headers: response.headers, text: '' }
            if (result.status < 200 || result.status >= 300) {
                response.resume()
                resolve(result)
                request.destroy()
                return
            }
            const encoding = response.headers['content-encoding']
            const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
                : encoding === 'br' ? createBrotliDecompress() : null
            if (encoding && encoding !== 'identity' && !decoder) {
                reject(new Error('网页使用了不支持的压缩格式'))
                request.destroy()
                return
            }
            const stream = decoder ? response.pipe(decoder) : response
            const chunks: Buffer[] = []
            let size = 0
            const fail = (error: Error): void => { reject(error); request.destroy(); decoder?.destroy() }
            response.on('error', () => fail(new Error('网页连接中断')))
            stream.on('error', () => fail(new Error('网页内容解码失败')))
            stream.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > 2 * 1024 * 1024) { fail(new Error('网页超过 2 MB 读取上限')); return }
                chunks.push(chunk)
            })
            stream.on('end', () => {
                const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(response.headers['content-type']))?.[1] ?? 'utf-8'
                try { result.text = new TextDecoder(charset).decode(Buffer.concat(chunks)) } catch {
                    reject(new Error('网页字符编码不受支持'))
                    return
                }
                resolve(result)
            })
        })
        request.on('error', error => {
            if (signal.aborted) { reject(signal.reason); return }
            // Socket errors can contain local hosts; only expose the useful error code.
            const code = (error as Error & { code?: string }).code
            reject(new Error(code ? `联网连接失败（${code}）` : error.message))
        })
        request.end()
    })
}

/** A configured search endpoint may be private. Arbitrary page URLs may not. */
export async function requestWeb (
    value: string, timeoutMs: number, signal: AbortSignal,
    trustedSearch = false, authorization = '',
): Promise<WebResponse> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('联网请求超时')), timeoutMs)
    try {
        let url = webURL(value)
        for (let redirects = 0; redirects <= 4; redirects++) {
            controller.signal.throwIfAborted()
            const response = await requestOnce(url, controller.signal, trustedSearch, authorization)
            if (![301, 302, 303, 307, 308].includes(response.status)) { return response }
            // Do not carry search credentials or queries to an unexpected endpoint.
            if (trustedSearch) { throw new Error('搜索接口发生重定向，请在设置中填写最终服务地址') }
            if (!response.headers.location) { throw new Error('网页重定向缺少目标地址') }
            url = webURL(new URL(response.headers.location, url).href)
        }
        throw new Error('网页重定向次数过多')
    } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
    }
}
