/* Isolated Electron + Docker SSH input profiling. No commands submitted by the probes. */
const assert = require('node:assert/strict')

exports.run = async ({ evaluate, wait, screen, call }) => {
    await evaluate(`ng.getComponent(document.querySelector('app-root')).app.selectTab(nativeTest); true`)
    await call('Page.bringToFront')
    await evaluate(`window.inputProbeText=()=>{
        const buffer=nativeTest.frontend.xterm.buffer.active
        return Array.from({length:buffer.cursorY+1},(_,i)=>buffer.getLine(buffer.baseY+i)?.translateToString(true,0,i===buffer.cursorY?buffer.cursorX:undefined)).join('')
    }; true`)
    for (const mode of ['agent', 'shell']) {
        await evaluate(`(async()=>{
            const dock=ng.getComponent(document.querySelector('ash-agent-dock'))
            await dock.terminal.setMode(dock.runtime,${JSON.stringify(mode)})
            return true
        })()`)
        await wait(mode === 'agent'
            ? 'ng.getComponent(document.querySelector("ash-agent-dock")).runtime.terminal.value.ready'
            : '!ng.getComponent(document.querySelector("ash-agent-dock")).terminal.attachments.get(nativeTest).integration.installed', mode + ' ready')
        // Exclude startup, resize, and uninstall prompt redraws from the typing probe.
        await evaluate(`(async()=>{
            const integration=ng.getComponent(document.querySelector('ash-agent-dock')).terminal.attachments.get(nativeTest).integration
            for(let attempt=0;attempt<50;attempt++) {
                const recent=integration.recent
                await new Promise(resolve=>setTimeout(resolve,100))
                if(integration.recent===recent) {
                    await new Promise(resolve=>nativeTest.frontend.xterm.write('',resolve))
                    return true
                }
            }
            throw new Error('Terminal did not settle before input probe')
        })()`)
        const metrics = await evaluate(`(async()=>{
            const dock=ng.getComponent(document.querySelector('ash-agent-dock'))
            const input=dock.terminal.attachments.get(nativeTest).input
            const application=nativeTestInjector.get(require('@angular/core').ApplicationRef)
            const tick=application.tick.bind(application)
            let ticks=0,updates=-1,written=0
            const write=nativeTest.write.bind(nativeTest)
            const subscription=dock.runtime.terminal.subscribe(()=>updates++)
            application.tick=()=>{ticks++;return tick()}
            nativeTest.write=text=>{written+=text.length;return write(text)}
            const text='ash_input_latency_'.repeat(8)+'END'
            const started=performance.now()
            try {
                for(const char of text) nativeTest.sendInput(char)
                const dispatchMs=performance.now()-started
                await input.settled()
                const xterm=nativeTest.frontend.xterm
                for(let attempt=0;attempt<200;attempt++) {
                    await new Promise(resolve=>xterm.write('',resolve))
                    const visible=inputProbeText()
                    if(visible.endsWith(text)) break
                    if(attempt===199)throw new Error('Echo did not render: '+JSON.stringify({visible,buffer:input.buffer,mode:dock.runtime.terminal.value}))
                    await new Promise(resolve=>setTimeout(resolve,5))
                }
                return {mode:${JSON.stringify(mode)},characters:text.length,dispatchMs:Math.round(dispatchMs),echoMs:Math.round(performance.now()-started),updates,ticks,written}
            } finally {
                nativeTest.sendInput('\\x15')
                await input.settled()
                subscription.unsubscribe();application.tick=tick;nativeTest.write=write
            }
        })()`)
        console.log('INPUT PROFILE', JSON.stringify(metrics))
        assert.ok(metrics.updates <= 1, 'Repeated keystrokes published redundant terminal states')
        await wait(`!Array.from({length:nativeTest.frontend.xterm.buffer.active.length},(_,i)=>nativeTest.frontend.xterm.buffer.active.getLine(i)?.translateToString(true)).join('').includes('ash_input_latency_')`, mode + ' burst cleared')
        await evaluate(`(async()=>{
            const input=ng.getComponent(document.querySelector('ash-agent-dock')).terminal.attachments.get(nativeTest).input
            await input.settled()
            const xterm=nativeTest.frontend.xterm
            xterm.focus()
            window.keyboardProfile={draft:'',pending:null,latencies:[]}
            keyboardProfile.data=xterm.onData(text=>{
                if(!/^[a-z_0-9]+$/.test(text))return
                keyboardProfile.draft+=text;keyboardProfile.pending=performance.now()
            })
            keyboardProfile.parsed=xterm.onWriteParsed(()=>{
                if(keyboardProfile.pending===null)return
                // Fish displays suggestions after the cursor; only measure typed text.
                const visible=inputProbeText()
                if(visible.endsWith(keyboardProfile.draft)) {
                    keyboardProfile.latencies.push(performance.now()-keyboardProfile.pending)
                    keyboardProfile.pending=null
                }
            })
            return true
        })()`)
        try {
            const text = 'ash_keyboard_123'
            for (let i = 0; i < text.length; i++) {
                await evaluate('nativeTest.frontend.xterm.focus(); true')
                await call('Input.dispatchKeyEvent', { type: 'char', text: text[i] })
                await wait('keyboardProfile.latencies.length===' + (i + 1), mode + ' keyboard echo ' + (i + 1))
            }
            const latencies = await evaluate('keyboardProfile.latencies')
            assert.equal(latencies.length, text.length)
            latencies.sort((a, b) => a - b)
            console.log('KEYBOARD TO PARSED ECHO', JSON.stringify({ mode, samples: latencies.length,
                medianMs: Math.round(latencies[Math.floor(latencies.length / 2)]), maxMs: Math.round(latencies.at(-1)) }))
        } catch (error) {
            console.error('KEYBOARD STATE', await evaluate(`JSON.stringify({draft:keyboardProfile.draft,pending:keyboardProfile.pending,latencies:keyboardProfile.latencies,visible:inputProbeText(),input:ng.getComponent(document.querySelector('ash-agent-dock')).terminal.attachments.get(nativeTest).input.buffer,focus:document.activeElement?.className})`))
            throw error
        } finally {
            await evaluate(`(async()=>{
                keyboardProfile.data.dispose();keyboardProfile.parsed.dispose()
                nativeTest.sendInput('\\x15')
                await ng.getComponent(document.querySelector('ash-agent-dock')).terminal.attachments.get(nativeTest).input.settled()
                return true
            })()`)
        }
        await wait(`!Array.from({length:nativeTest.frontend.xterm.buffer.active.length},(_,i)=>nativeTest.frontend.xterm.buffer.active.getLine(i)?.translateToString(true)).join('').includes('ash_keyboard_123')`, mode + ' keyboard cleared')
    }
    await screen('input-profile')
}
