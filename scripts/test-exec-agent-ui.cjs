/* Runs against the disposable SSH fixture from test-native-agent-docker.cjs. */
const assert = require('node:assert/strict')

exports.run = async ({ evaluate, wait, screen, call }) => {
    const filename = '/tmp/ash-exec-vim-paste-' + process.env.ASH_TEST_SHELL + '.txt'
    const dock = 'ng.getComponent(document.querySelector("ash-agent-dock"))'
    const send = text => evaluate(`nativeTest.sendInput(${JSON.stringify(text)}); true`)
    const request = text => evaluate(`${dock}.zone.run(() => { ${dock}.draft=${JSON.stringify(text)}; ${dock}.send() }); true`)
    const execute = command => evaluate(`${dock}.terminal.execute(${dock}.runtime, ${JSON.stringify(command)})`)
    await evaluate(`nativeTest.testWrites=[]; const original=nativeTest.session.write.bind(nativeTest.session); nativeTest.session.write=data=>{nativeTest.testWrites.push(data.toString());original(data)}; true`)

    const failed = await execute('printf "UTF8 中文\\n"; printf "STDERR\\n" >&2; false')
    assert.equal(failed.exitCode, 1)
    assert.match(failed.output, /UTF8 中文/)
    assert.match(failed.output, /STDERR/)
    assert.equal(await evaluate('nativeTest.testWrites.length'), 0, 'Exec wrote to the interactive shell')

    await send('vim -Nu NONE ' + filename + '\r')
    await wait('nativeTest.alternateScreenActive', 'Vim alternate screen')
    await send('i')
    await wait('nativeTest.frontend.supportsBracketedPaste()', 'Vim bracketed paste')
    const pasted = 'first\n    中文 second\nthird\n'
    await evaluate(`(async()=>{
        const original=nativeTest.platform.readClipboard;
        nativeTest.platform.readClipboard=()=>${JSON.stringify(pasted)};
        const settings=nativeTest.config.store.terminal;
        const replace=settings.replaceNewlinesWithSpacesOnPaste;
        const trim=settings.trimWhitespaceOnPaste;
        settings.replaceNewlinesWithSpacesOnPaste=true; settings.trimWhitespaceOnPaste=true;
        try { await nativeTest.paste() } finally {
            nativeTest.platform.readClipboard=original;
            settings.replaceNewlinesWithSpacesOnPaste=replace; settings.trimWhitespaceOnPaste=trim;
        }
        return true
    })()`)
    await screen('vim-multiline-paste')
    const clipboard = await evaluate(`(async()=>{
        const platform=nativeTest.platform;
        const originalSet=platform.setClipboard, originalMenu=platform.popupContextMenu;
        const setting=nativeTest.config.store.terminal.rightClick;
        let copied='', menus=0;
        platform.setClipboard=value=>{copied=value.text};
        platform.popupContextMenu=items=>{
            menus++;
            const copy=items.find(item=>['Copy','复制'].includes(item.label));
            if (copy?.enabled) copy.click();
        };
        nativeTest.config.store.terminal.rightClick='clipboard';
        const target=nativeTest.frontend.xterm.element.querySelector('.xterm-screen');
        const click=async ()=>{
            target.dispatchEvent(new MouseEvent('mousedown',{button:2,buttons:2,bubbles:true}));
            target.dispatchEvent(new MouseEvent('mouseup',{button:2,buttons:0,bubbles:true}));
            await new Promise(resolve=>setTimeout(resolve,50));
        };
        const writes=nativeTest.testWrites.length;
        try {
            nativeTest.frontend.xterm.select(0,0,5);
            copied='';
            await click();
            nativeTest.frontend.clearSelection();
            await click();
            return {copied,menus,writes:nativeTest.testWrites.length-writes};
        } finally {
            platform.setClipboard=originalSet; platform.popupContextMenu=originalMenu;
            nativeTest.config.store.terminal.rightClick=setting;
        }
    })()`)
    assert.equal(clipboard.copied, 'first')
    assert.equal(clipboard.menus, 2)
    assert.equal(clipboard.writes, 0, 'Clipboard clicks leaked to Vim')
    const before = await evaluate('nativeTest.testWrites.length')
    await request('审批测试')
    await wait(`${dock}.requests.length === 1`, 'Agent command approval while Vim is active')
    await evaluate(`${dock}.zone.run(()=>${dock}.approve(${dock}.requests[0])); true`)
    await wait(`!${dock}.runtime.activeRunId`, 'Agent execution completion while Vim is active')
    assert.equal(await evaluate('nativeTest.alternateScreenActive'), true)
    assert.equal(await evaluate('nativeTest.testWrites.length'), before, 'Agent touched Vim input')
    assert.match(await evaluate(`${dock}.transcript`), /APPROVAL_OK/)
    await screen('agent-with-vim')
    await send('\x1b:wq\r')
    await wait('!nativeTest.alternateScreenActive', 'Vim saves and exits')
    const file = await execute('cat ' + filename)
    assert.equal(file.exitCode, 0)
    assert.equal(file.output, pasted + '\n', 'Vim paste changed indentation or line endings')
    assert.equal(await evaluate('nativeTest.testWrites.some(text=>/__ash_|base64 -d|__TABBY_AI_/.test(text))'), false)

    await request('停止测试')
    await wait(`${dock}.requests.length === 1`, 'sleep approval')
    await evaluate(`${dock}.zone.run(()=>${dock}.approve(${dock}.requests[0])); true`)
    await wait(`${dock}.terminal.isExecuting(${dock}.runtime)`, 'sleep started')
    await evaluate(`${dock}.runtime.stopAgent(); true`)
    await wait(`!${dock}.runtime.activeRunId && !${dock}.terminal.isExecuting(${dock}.runtime)`, 'stop releases Agent')
    assert.equal((await execute('printf RECOVERED')).output, 'RECOVERED')

    await call('Emulation.setDeviceMetricsOverride', { width: 760, height: 680, deviceScaleFactor: 1, mobile: false })
    await execute('printf "LONG_LINE_' + 'x'.repeat(350) + '\\n"')
    await screen('history-narrow-window')
    assert.equal(await evaluate(`(()=>{const e=document.querySelector('.agent-transcript');return e.scrollWidth <= e.clientWidth + 1})()`), true)
    const history = await evaluate(`${dock}.transcript`)
    assert.equal(history.includes('\x1b'), false)
    assert.match(history, /交互程序画面已省略/)
    console.log('PASS real SSH: isolated stdout/stderr/exit status, Vim + Agent concurrency, multiline paste, stop/retry, responsive history')
}
