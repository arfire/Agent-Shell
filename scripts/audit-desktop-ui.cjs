/* Isolated desktop UI audit. Fixtures are synthetic; inputs use Chromium CDP. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), { spawn } = require('node:child_process'), WebSocket = require('../node_modules/ws'), yaml = require('../tabby-ai/node_modules/js-yaml');
const root = path.resolve(__dirname, '..'), directory = path.join(root, '.build-cache', 'desktop-audit-' + Date.now());
fs.mkdirSync(directory, { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
let electron, socket;
const evidence = [];
const visible = `e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight&&getComputedStyle(e).visibility!=='hidden'}`;
async function main() {
    fs.writeFileSync(path.join(directory, 'config.yaml'), yaml.dump({ version: 7, enableAnalytics: false, enableAutomaticUpdates: false, enableWelcomeTab: false, language: 'zh-CN', appearance: { colorSchemeMode: 'dark' }, recovery: [], ssh: {verifyHostKeys:false}, profiles: [{ id: 'audit-ssh', type: 'ssh', name: '审计 SSH 配置', options: { host: 'example.invalid', port: 22, user: 'tester' } }] }));
    const reserve = http.createServer();
    await new Promise(r => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise(r => reserve.close(r));
    const bootstrap = path.join(directory, 'bootstrap.cjs');
    fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.join(root, 'app'))});app.requestSingleInstanceLock=()=>true;app.setAsDefaultProtocolClient=()=>false;require(${JSON.stringify(path.join(root, 'app/dist/main.js'))});`);
    const log = fs.openSync(path.join(directory, 'electron.log'), 'w');
    electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, '--remote-debugging-port=' + port], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, TABBY_DEV: '1', TABBY_DATA_DIRECTORY: directory, TABBY_CONFIG_DIRECTORY: directory } });
    let target;
    for (let i = 0; i < 150; i++) {
        try {
            target = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(x => x.type === 'page');
            if (target)
                break;
        }
        catch { }
        await delay(150);
    }
    if (!target)
        throw new Error('No isolated renderer');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => socket.once('open', r));
    let id = 0;
    const pending = new Map();
    socket.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id, t = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout ' + method)); }, 15000); pending.set(n, m => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); socket.send(JSON.stringify({ id: n, method, params })); });
    const read = async (expression) => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails)
        throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const wait = async (expression) => { for (let i = 0; i < 150; i++) {
        if (await read(expression))
            return;
        await delay(100);
    } throw new Error('UI timeout ' + expression + ' ' + await read('document.body.innerText.slice(-1500)')); };
    const zone = code => read(`ng.getInjector(document.querySelector('app-root')).get(require('@angular/core').NgZone).run(async()=>{${code}})`);
    const click = async (selector, text, index = 0) => { const p = await read(`(()=>{const es=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible});const e=es.find(e=>${text === undefined ? 'es.indexOf(e)===' + index : 'e.textContent.trim()===' + JSON.stringify(text)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); if (!p)
        throw new Error('Missing control ' + selector + ' ' + text); for (const type of ['mousePressed', 'mouseReleased'])
        await call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }); await delay(180); };
    const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => { for (const type of ['keyDown', 'keyUp'])
        await call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers }); await delay(150); };
    const screenshot = async (name, detail) => { await delay(200); const file = path.join(directory, name + '.png'); fs.writeFileSync(file, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.push({ name, file, detail, dom: await read('document.body.innerText') }); console.log('CAPTURE', file); };
    await wait('!!window.ng?.getComponent?.(document.querySelector("app-root"))?.ready');
    await screenshot('01-start', 'Fresh isolated desktop; no actual server connected');
    await click('button', '连接服务器');
    await wait('!!document.querySelector("#ssh-connect-host")');
    assert.equal(await read('document.querySelector("form button[type=submit]").disabled'), true);
    await screenshot('00-connect-form', 'Production graphical SSH connection form, empty fields');
    for (const [selector,value] of [['#ssh-connect-host','example.invalid'],['#ssh-connect-user','tester'],['#ssh-connect-port','70000']]) {
        await click(selector); await key('a','KeyA',65,2); await call('Input.insertText',{text:value});
    }
    await click('#ssh-connect-user');
    assert.equal(await read('document.querySelector("form button[type=submit]").disabled'), true);
    await click('#ssh-connect-port'); await key('a','KeyA',65,2); await call('Input.insertText',{text:'2222'}); await click('#ssh-connect-user');
    assert.equal(await read('document.querySelector("form button[type=submit]").disabled'), false);
    await screenshot('00-connect-form-filled','Native keyboard input; valid host/user/port enables connection; invalid port is rejected');
    if (process.env.ASH_TEST_SSH_PORT) {
        await read('localStorage.recentProfiles=JSON.stringify([{type:"ssh",name:"旧记录",options:{host:"example.invalid",password:"synthetic-history-secret"}}]);true');
        for (const [selector,value] of [['#ssh-connect-host','127.0.0.1'],['#ssh-connect-port',process.env.ASH_TEST_SSH_PORT],['#ssh-connect-user','ashbash'],['#ssh-connect-password',process.env.ASH_TEST_PASSWORD]]) {
            await click(selector); await key('a','KeyA',65,2); await call('Input.insertText',{text:value});
        }
        await click('#ssh-connect-save'); await click('#ssh-connect-remember'); await click('#ssh-connect-name'); await call('Input.insertText',{text:'表单真实连接'});
        await click('form button[type=submit]'); await wait('!document.querySelector("ngb-modal-window")');
        await wait('[...document.querySelectorAll("ssh-tab")].some(e=>ng.getComponent(e)?.session?.open)');
        const saved=yaml.load(fs.readFileSync(path.join(directory,'config.yaml'),'utf8')).profiles.find(p=>p.name==='表单真实连接');
        assert.ok(saved); assert.equal(saved.options.password,undefined);
        assert.equal(yaml.load(fs.readFileSync(path.join(directory,'config.yaml'),'utf8')).vault.version,2);
        assert.equal(await zone(`const i=ng.getInjector(document.querySelector("app-root"));const profile=i.get(require("tabby-core").ConfigService).store.profiles.find(p=>p.name==='表单真实连接');return (await i.get(require("tabby-ssh").PasswordStorageService).loadPassword(profile))===${JSON.stringify(process.env.ASH_TEST_PASSWORD)}`),true);
        await zone('await ng.getInjector(document.querySelector("app-root")).get(require("tabby-core").ConfigService).save();return true');
        assert.ok(!fs.readFileSync(path.join(directory,'config.yaml'),'utf8').includes(process.env.ASH_TEST_PASSWORD));
        assert.ok(!await read('localStorage.recentProfiles.includes("synthetic-history-secret")'));
        assert.ok(!await read(`localStorage.recentProfiles.includes(${JSON.stringify(process.env.ASH_TEST_PASSWORD)})`));
        await zone('window.uiLiveTab=[...document.querySelectorAll("ssh-tab")].map(e=>ng.getComponent(e)).find(t=>t.session?.open);window.uiSession=uiLiveTab.session;const i=ng.getInjector(document.querySelector("app-root"));const c=require("tabby-core");const recovery=i.get(c.TabRecoveryService);recovery.enabled=true;i.get(c.ConfigService).store.recoverTabs=true;await recovery.saveTabs(ng.getComponent(document.querySelector("app-root")).app.tabs);return true');
        assert.ok(!await read(`localStorage.tabsRecovery.includes(${JSON.stringify(process.env.ASH_TEST_PASSWORD)})`));
        await zone('delete uiLiveTab.profile.options.password;await uiLiveTab.reconnect();return true');
        await wait('uiLiveTab.session?.open && uiLiveTab.session!==uiSession');
        await screenshot('00-connect-real-ssh','Native graphical form saved the password in portable vault v2 and reconnected real SSH using the vault; YAML, recent profiles and persisted recovery tokens contain no plaintext login password');
    } else { await click('button','取消'); await wait('!document.querySelector("ngb-modal-window")'); }
    await click('.btn-tab-bar', undefined, 1);
    await wait('!!document.querySelector("ngb-modal-window input.form-control-lg")');
    await screenshot('02-connect-selector', 'Existing address picker remains available alongside the graphical connection form');
    await click('ngb-modal-window input.form-control-lg');
    await call('Input.insertText', { text: 'tester@example.invalid:2222' });
    await delay(300);
    await screenshot('03-connect-address', 'Optional legacy address input');
    await key('Escape', 'Escape', 27);
    await wait('!document.querySelector("ngb-modal-window")');
    await delay(350);
    // Open the existing profile editor through its real settings surface.
    await click('.btn-tab-bar', undefined, 1);
    await wait('!!document.querySelector("ngb-modal-window")');
    const manage = await read(`[...document.querySelectorAll('ngb-modal-window .title')].find(e=>/管理|Manage/.test(e.textContent))?.textContent.trim()`);
    if (!manage)
        throw new Error('Manage profiles unavailable');
    await click('ngb-modal-window .title', manage);
    await wait('!!document.querySelector("profiles-settings-tab") || document.body.innerText.includes("默认配置") || document.body.innerText.includes("Profiles")');
    await screenshot('04-profile-management', 'Existing graphically editable profile path is deeper than quick connect');
    // Fixture setup selects the saved synthetic profile editor; screenshots are actual production component rendering.
    await zone(`const injector=ng.getInjector(document.querySelector('app-root'));const core=require('tabby-core');const profiles=injector.get(core.ProfilesService);const profile=(await profiles.getProfiles()).find(p=>p.id==='audit-ssh');const settings=require('tabby-settings');const modal=injector.get(require('@ng-bootstrap/ng-bootstrap').NgbModal).open(settings.EditProfileModalComponent,{size:'lg'});modal.componentInstance.partialProfile=profile;modal.componentInstance.profileProvider=profiles.providerForProfile(profile);return true`);
    await wait('!!document.querySelector("ngb-modal-window input[type=number]")');
    await screenshot('05-existing-ssh-form', 'Existing SSH profile editor has host/port/user fields, opened with fixture setup');
    await key('Escape', 'Escape', 27);
    await wait('!document.querySelector("ngb-modal-window")');
    await delay(350);
    // Inject synthetic transfer state only; interaction remains native CDP input.
    await zone(`const core=require('tabby-core');const root=ng.getComponent(document.querySelector('app-root'));class AuditUpload extends core.FileUpload {constructor(name,size){super();this.name=name;this.size=size}getName(){return this.name}getSize(){return this.size}getMode(){return 420}close(){}async read(){return Buffer.alloc(0)}advance(n){this.increaseProgress(n)}};window.auditTransfers=[new AuditUpload('生产发布包_中文目录_'+ '长文件名'.repeat(12)+'.tar.gz',10000000),new AuditUpload('上传失败_权限不足.txt',1000),new AuditUpload('已完成.txt',1000),new AuditUpload('等待传输.txt',0)];auditTransfers[0].advance(3500000);auditTransfers[1].setError('权限不足，请检查目标目录的写入权限。');auditTransfers[1].cancel();auditTransfers[2].setCompleted(true);auditTransfers[0].setEndpoints('发布包','/srv/releases/发布包.tar.gz');root.activeTransfers=auditTransfers;return true`);
    await click('.tab-bar button[ngbdropdowntoggle]');
    await wait('!!document.querySelector("transfers-menu.show")');
    await screenshot('06-transfer-states', 'Synthetic active/failed/complete/unknown size shown by actual transfer menu');
    const details = await read(`(()=>{const menu=document.querySelector('transfers-menu');return {text:menu.innerText,width:menu.getBoundingClientRect().width,accessibleButtons:[...menu.querySelectorAll('button')].map(b=>({text:b.textContent,aria:b.getAttribute('aria-label'),title:b.getAttribute('title')})),progress:[...menu.querySelectorAll('[role=progressbar]')].map(e=>({value:e.getAttribute('aria-valuenow'),label:e.getAttribute('aria-label')}))}})()`);
    assert.ok(details.text.includes('权限不足') && details.text.includes('已完成') && details.text.includes('取消全部'));
    assert.ok(details.accessibleButtons.every(b=>b.text.trim()||b.aria||b.title));
    assert.ok(details.progress.some(p=>p.value==='100'));
    assert.ok(details.progress.every(p=>p.label?.includes('传输进度')));
    evidence.push({ name: 'transfer-dom', details });
    await call('Emulation.setDeviceMetricsOverride', { width: 760, height: 600, deviceScaleFactor: 1, mobile: false });
    await delay(300);
    console.log('NARROW_LAYOUT', await read('(()=>{const e=document.querySelector("transfers-menu");const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,parent:e.parentElement.outerHTML.slice(0,180)}})()'));
    await screenshot('07-transfer-narrow', 'Transfer menu after window resize');
    assert.ok(await read('(()=>{const r=document.querySelector("transfers-menu").getBoundingClientRect();return r.width<=innerWidth && r.left>=0 && r.right<=innerWidth})()'),'Transfer menu extends outside viewport');

    await call('Emulation.clearDeviceMetricsOverride');
    await click('button','清除已结束');
    assert.equal(await read('ng.getComponent(document.querySelector("app-root")).activeTransfers.length'),2);
    assert.equal(await read('auditTransfers[0].isCancelled()'),false);
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ scope: process.env.ASH_TEST_SSH_PORT ? 'Native graphical form established real SSH and saved without password; transfer menu states are synthetic; real SFTP is tested separately' : 'Electron graphical form and transfer menu with synthetic fixtures; real SSH/SFTP tested separately', evidence }, null, 2));
    console.log('Desktop audit evidence: ' + directory);
}
main().catch(error => { console.error(error); fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: String(error), evidence }, null, 2)); process.exitCode = 1; }).finally(() => { socket?.close(); electron?.kill(); });
