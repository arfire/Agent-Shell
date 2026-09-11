/* DOM is read only for locating visible controls/assertions. Every input goes
 * through Chromium Input events, never Angular/app methods or synthetic clicks. */
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('../node_modules/ws')
const root = path.resolve(__dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
exports.connect = async () => {
    const info = JSON.parse(fs.readFileSync(path.join(root, '.build-cache/agent-blackbox-current.json'), 'utf8'))
    let target
    for (let i = 0; i < 100; i++) {
        try { target = (await (await fetch('http://127.0.0.1:' + info.debugPort + '/json')).json()).find(t => t.type === 'page'); if (target) break } catch {}
        await delay(200)
    }
    if (!target) throw new Error('Blackbox app did not start')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise(resolve => socket.once('open', resolve))
    const pending = new Map(), errors = [], checks = []
    let next = 0
    socket.on('message', raw => {
        const message = JSON.parse(raw)
        if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    })
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++next
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)) }, 15000)
        pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result) })
        socket.send(JSON.stringify({ id, method, params }))
    })
    const read = async expression => {
        const r = await call('Runtime.evaluate', { expression, returnByValue: true })
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
        return r.result.value
    }
    const visible = `e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight&&getComputedStyle(e).visibility!=='hidden'}`
    const locate = async (selector, text) => read(`(()=>{const elements=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible});const e=elements.find(e=>${text===undefined?'true':`e.textContent.trim()===${JSON.stringify(text)}`});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:e.disabled,text:e.textContent,focused:e===document.activeElement}})()`)
    const wait = async (expression, label, timeout = 15000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) { if (await read(expression)) return; await delay(100) }
        await screenshot('failure-' + label.replace(/\W+/g, '-'))
        throw new Error('Timed out: ' + label + '\n' + await read('document.body.innerText.slice(-3000)'))
    }
    const click = async (selector, text, button = 'left', count = 1) => {
        const p = await locate(selector, text)
        if (!p || p.disabled || p.x < 0 || p.y < 0 || p.x >= await read('innerWidth') || p.y >= await read('innerHeight')) throw new Error('Control unavailable: ' + selector + ' ' + text)
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: count })
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: count })
        await delay(150)
    }
    const key = async (key, code, modifiers = 0) => {
        await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: ({ Enter:13, Escape:27, Tab:9, ArrowUp:38, ArrowDown:40, ArrowLeft:37, ArrowRight:39, Backspace:8, Delete:46, Home:36, End:35 })[key] ?? key.toUpperCase().charCodeAt(0) })
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
        await delay(80)
    }
    const type = async text => { await call('Input.insertText', { text }); await delay(100) }
    const screenshot = async name => {
        const r = await call('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(info.directory, name + '.png'), Buffer.from(r.data, 'base64'))
    }
    const report = (name, detail = '') => {
        checks.push({ name, detail, time: new Date().toISOString() })
        fs.appendFileSync(path.join(info.directory, 'blackbox-checks.jsonl'), JSON.stringify(checks.at(-1)) + '\n')
    }
    await call('Runtime.enable')
    return { info, call, read, locate, wait, click, key, type, screenshot, report, errors, checks, close:()=>socket.close() }
}
