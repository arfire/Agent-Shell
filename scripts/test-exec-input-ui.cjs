/* Native keyboard input against the independent Agent panel and real SSH PTY. */
const assert = require('node:assert/strict')
exports.run = async ({evaluate,wait,screen,call}) => {
    const dock = 'ng.getComponent(document.querySelector("ash-agent-dock"))'
    const click = async selector => {
        const r=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1})
        await new Promise(r=>setTimeout(r,180))
    }
    const key = async (key,code,windowsVirtualKeyCode,modifiers=0) => {
        for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode,modifiers})
    }
    await evaluate(`nativeTestInjector.get(require('@angular/core').NgZone).run(()=>ng.getComponent(document.querySelector('app-root')).app.selectTab(nativeTest.topmostParent ?? nativeTest));true`)
    await wait('document.querySelector(".agent-composer textarea").getBoundingClientRect().height>0','Visible input composer')
    await evaluate(`nativeTest.testWrites=[];const original=nativeTest.session.write.bind(nativeTest.session);nativeTest.session.write=data=>{nativeTest.testWrites.push(data.toString());original(data)};true`)
    await new Promise(r=>setTimeout(r,400))
    await click('.agent-composer textarea')
    assert.equal(await evaluate('document.activeElement===document.querySelector(".agent-composer textarea")'),true,'Native click did not focus composer')
    const text='中文输入\n多行粘贴_123'
    await call('Input.insertText',{text})
    await wait(`document.querySelector('.agent-composer textarea').value===${JSON.stringify(text)}`,'Chinese multiline draft')
    assert.equal(await evaluate('nativeTest.testWrites.filter(t=>!/^\\x1b\\[(?:\\d+;\\d+R|\\?[\\d;]+c)$/.test(t)).length'),0,'Agent draft reached SSH input')
    await key('a','KeyA',65,2)
    await call('Input.insertText',{text:'只分析，不调用工具。输入测试'})
    await wait(`${dock}.draft==='只分析，不调用工具。输入测试' && !document.querySelector('.agent-composer button').disabled`,'Ready input draft')
    await screen('input-before-submit')
    await click('.agent-composer button')
    await wait(`${dock}.transcript.includes('当前终端工作正常') && !${dock}.runtime.activeRunId`,'native Agent submission completed')
    await click('.mode-button')
    await wait(`${dock}.runtime.terminal.value.mode==='shell'`,'Shell mode selected')
    await evaluate('nativeTest.frontend.xterm.focus();true')
    const draft='ash_keyboard_123'
    for(const char of draft)await call('Input.dispatchKeyEvent',{type:'char',text:char})
    await wait(`inputProbeText().endsWith(${JSON.stringify(draft)})`,'native Shell keystrokes echoed')
    assert.ok((await evaluate('nativeTest.testWrites.join("")')).includes(draft),'Shell typing did not reach remote')
    await key('u','KeyU',85,2)
    await wait('!inputProbeText().includes("ash_keyboard_123")','Shell draft cleared without executing')
    await click('.mode-button')
    await wait(`!!document.querySelector('.agent-composer textarea')`,'Agent composer restored')
    await screen('independent-input-profile')
    console.log('PASS native input: Chinese/multiline Agent draft stays local, submit completes, Shell keyboard echoes, mode switching restores composer')
}
