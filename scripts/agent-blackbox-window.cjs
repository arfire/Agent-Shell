/* Fixture-only native window sizing. Never emulates a viewport inside a larger window. */
exports.attach = (app, BrowserWindow, directory) => {
    const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
    const { Menu } = require('electron')
    let menuPopups = 0
    const popup = Menu.prototype.popup
    Menu.prototype.popup = function (...args) { menuPopups++; return popup.apply(this, args) }
    let original
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/state') { res.end(JSON.stringify({ menuPopups })); return }
        if (req.method !== 'POST' || req.url !== '/resize') { res.writeHead(404); res.end(); return }
        try {
            let body = ''
            for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error('Invalid size') }
            const size = JSON.parse(body)
            const window = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
            if (!window) throw new Error('No fixture window')
            if (!original) original = window.getContentSize()
            const [width, height] = size.width == null ? original : [Number(size.width), Number(size.height)]
            if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240 || width > 3000 || height > 2200) throw new Error('Invalid size')
            window.setContentSize(width, height)
            setTimeout(() => res.end(JSON.stringify(window.getContentSize())), 300)
        } catch (error) { res.writeHead(400); res.end(String(error)) }
    })
    server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(directory, 'window-control.json'), JSON.stringify({ port: server.address().port })))
    app.on('will-quit', () => server.close())
}
