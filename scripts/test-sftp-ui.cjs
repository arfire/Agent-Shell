/* Called by test-native-agent-ui.cjs against its isolated Docker SSH connection. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

exports.run = async ({ directory, evaluate, wait, screen }) => {
    const inZone = code => evaluate('(async()=>{const zone=nativeTestInjector.get(require("@angular/core").NgZone);return await zone.run(async()=>{' + code + '})})()')
    const source = path.join(directory, '上传测试.bin')
    const data = Buffer.alloc(700000)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    fs.writeFileSync(source, data)
    await inZone('ng.getComponent(document.querySelector("workspace-sidebar")).select("files");return true')
    await wait('!!ng.getComponent(document.querySelector("sftp-panel"))?.fileList', 'SFTP sidebar')
    await inZone(`
        window.sftpPanel=ng.getComponent(document.querySelector('sftp-panel'))
        await sftpPanel.navigate('/tmp')
        window.sftpNotices=[]
        const notify=sftpPanel.notifications.error.bind(sftpPanel.notifications)
        sftpPanel.notifications.error=message=>{sftpNotices.push(message);notify(message)}
        window.sftpTransfer=(await sftpPanel.platform.startUpload({multiple:false},[${JSON.stringify(source)}]))[0]
        await sftpPanel.uploadOne(sftpTransfer)
        return true
    `)
    assert.deepEqual(await evaluate('sftpNotices'), [], 'Desktop upload raised an error')
    assert.equal(await evaluate('sftpTransfer.isComplete()'), true)
    assert.equal(await evaluate('sftpPanel.fileList.find(f=>f.name==="上传测试.bin")?.size'), data.length)
    const readback = await inZone(`
        const handle=await sftpPanel.sftp.open('/tmp/上传测试.bin',require('russh').OPEN_READ)
        const chunks=[]
        try { while(true) {const chunk=await handle.read();if(!chunk.length)break;chunks.push(chunk)} }
        finally {await handle.close()}
        return Buffer.concat(chunks).toString('base64')
    `)
    assert.deepEqual(Buffer.from(readback, 'base64'), data)
    console.log('PASS Electron file picker upload: remote listing and exact content')

    await inZone(`
        const core=require('tabby-core')
        window.dragTransfer=new core.HTMLFileUpload(new File(['拖拽文件内容'],'拖拽.txt'))
        const tree=new core.DirectoryUpload()
        const folder=new core.DirectoryUpload('拖拽目录')
        folder.pushChildren(dragTransfer);tree.pushChildren(folder)
        await sftpPanel.uploadOneFolder(tree)
        return true
    `)
    assert.equal(await evaluate('dragTransfer.isComplete()'), true)
    assert.equal(await inZone('return (await sftpPanel.sftp.stat("/tmp/拖拽目录/拖拽.txt")).size'), Buffer.byteLength('拖拽文件内容'))
    console.log('PASS Electron HTML drag upload into nested folder')

    await inZone(`
        const core=require('tabby-core')
        const tree=new core.DirectoryUpload()
        window.deniedTransfer=new core.HTMLFileUpload(new File(['permission test'],'denied.txt'))
        tree.pushChildren(deniedTransfer)
        await sftpPanel.uploadOneFolder(tree,'/../../root')
        return true
    `)
    assert.equal(await evaluate('deniedTransfer.isComplete()'), false)
    assert.equal(await evaluate('deniedTransfer.isCancelled()'), true)
    assert.match((await evaluate('sftpNotices')).join('\n'), /Permission denied/)
    await screen('sftp-upload-error')
    console.log('PASS Electron upload error is visible and never marked successful')
    console.log('SFTP screenshots and isolated data:', directory)
}
