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

    const downloadDirectory=path.join(directory,'download-output')
    fs.mkdirSync(downloadDirectory,{recursive:true})
    await inZone(`
        const platform=sftpPanel.platform
        const pick=platform.pickDirectory, start=platform.startDownloadDirectory
        platform.pickDirectory=async()=>${JSON.stringify(downloadDirectory)}
        platform.startDownloadDirectory=async(...args)=>{window.folderTransfer=await start.apply(platform,args);return folderTransfer}
        try {await sftpPanel.downloadFolder(await sftpPanel.sftp.stat('/tmp/拖拽目录'))}
        finally {platform.pickDirectory=pick;platform.startDownloadDirectory=start}
        return true
    `)
    assert.equal(fs.readFileSync(path.join(downloadDirectory,'拖拽目录','拖拽.txt'),'utf8'),'拖拽文件内容')
    assert.equal(await evaluate('folderTransfer.isComplete()'),true)
    assert.equal(await evaluate('folderTransfer.getCompletedBytes()'),Buffer.byteLength('拖拽文件内容'))
    console.log('PASS Electron directory download: exact nested content and aggregate progress')

    await inZone(`
        const platform=sftpPanel.platform, core=require('tabby-core')
        await sftpPanel.sftp.mkdir('/tmp/cancel-folder')
        await sftpPanel.sftp.upload('/tmp/cancel-folder/large.bin',new core.HTMLFileUpload(new File([new Uint8Array(700000)],'large.bin')))
        const pick=platform.pickDirectory,start=platform.startDownloadDirectory
        platform.pickDirectory=async()=>${JSON.stringify(downloadDirectory)}
        let cancellation
        platform.startDownloadDirectory=async(...args)=>{
            window.cancelFolderTransfer=await start.apply(platform,args)
            const create=cancelFolderTransfer.createFile.bind(cancelFolderTransfer)
            cancelFolderTransfer.createFile=async(...fileArgs)=>{
                const file=await create(...fileArgs)
                cancellation=file.progress$.subscribe(()=>cancelFolderTransfer.cancel())
                return file
            }
            return cancelFolderTransfer
        }
        try {await sftpPanel.downloadFolder(await sftpPanel.sftp.stat('/tmp/cancel-folder'))}
        finally {cancellation?.unsubscribe();platform.pickDirectory=pick;platform.startDownloadDirectory=start}
        return true
    `)
    assert.equal(await evaluate('cancelFolderTransfer.isCancelled()'),true)
    assert.equal(await evaluate('cancelFolderTransfer.isComplete()'),false)
    assert.equal(await evaluate('cancelFolderTransfer.getError()'),'')
    assert.ok(fs.statSync(path.join(downloadDirectory,'cancel-folder','large.bin')).size<700000)
    assert.deepEqual(await evaluate('sftpNotices'),[],'Cancelled folder download raised an error')
    console.log('PASS Electron directory cancellation stops the active file before completion')

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
    assert.match((await evaluate('sftpNotices')).join('\n'), /权限不足/)
    await screen('sftp-upload-error')
    console.log('PASS Electron upload error is visible and never marked successful')
    console.log('SFTP screenshots and isolated data:', directory)
}
