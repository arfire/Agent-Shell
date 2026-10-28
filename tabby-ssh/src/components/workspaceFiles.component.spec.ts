import * as assert from 'node:assert/strict'
import { SSHTabComponent } from './sshTab.component'
import { SFTPPanelComponent } from './sftpPanel.component'
import { WorkspaceFilesComponent } from './workspaceFiles.component'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    const fixture = () => {
        let cwd = '/start'
        const pending = new Map<string, { resolve: (value: any[]) => void, reject: (error: Error) => void }>(), calls: string[] = [], errors: string[] = []
        const ssh = { open: true }
        const tab = Object.assign(Object.create(SSHTabComponent.prototype), { sshSession: ssh, sftpPath: '/start', session: { open: true, getWorkingDirectory: async () => cwd } })
        const panel: any = new SFTPPanelComponent({} as any, { error: message => errors.push(message) } as any, {} as any, [])
        panel.session = ssh
        panel.path = '/start'
        panel.fileList = []
        panel.sftp = { readdir: path => { calls.push(path); return new Promise((resolve, reject) => pending.set(path, { resolve, reject })) } }
        panel.pathChange.subscribe(path => { tab.sftpPath = path })
        const files = new WorkspaceFilesComponent()
        files.sshTab = tab
        files.panel = panel
        files.directory = cwd
        files.followDirectory = true
        return { files, panel, tab, calls, errors, cd: path => { cwd = path; return files.refresh() }, finish: (path, name) => pending.get(path)!.resolve([{ name, isDirectory: true }]) }
    }
    await test('a newer terminal directory wins even when the old listing completes last', async () => {
        const f = fixture()
        const first = f.cd('/slow'); await Promise.resolve()
        const second = f.cd('/latest'); await Promise.resolve()
        assert.deepEqual(f.calls, ['/slow', '/latest'])
        f.finish('/latest', 'latest-file'); await second
        f.finish('/slow', 'stale-file'); await first
        assert.equal(f.panel.path, '/latest')
        assert.equal(f.panel.fileList[0].name, 'latest-file')
        assert.equal(f.tab.sftpPath, '/latest')
    })
    await test('returning to the displayed directory cancels a pending move elsewhere', async () => {
        const f = fixture()
        const first = f.cd('/slow'); await Promise.resolve()
        const second = f.cd('/start'); await Promise.resolve()
        assert.deepEqual(f.calls, ['/slow', '/start'])
        f.finish('/start', 'home'); await second
        f.finish('/slow', 'stale'); await first
        assert.equal(f.panel.path, '/start')
        assert.equal(f.panel.fileList[0].name, 'home')
    })
    await test('follow off preserves manual browsing; one-click jump still works', async () => {
        const f = fixture()
        f.files.followDirectory = false
        await f.cd('/target')
        assert.deepEqual(f.calls, [])
        const jump = f.files.jump()
        f.finish('/target', 'target'); await jump
        assert.equal(f.panel.path, '/target')
    })
    await test('new SSH connection never navigates the previous connection panel', async () => {
        const f = fixture()
        const next = Object.assign(Object.create(SSHTabComponent.prototype), { sshSession: { open: true }, sftpPath: '/', session: { open: true, getWorkingDirectory: async () => '/new-server' } })
        f.files.sshTab = next
        await f.files.refresh()
        assert.deepEqual(f.calls, [])
        assert.equal(next.sftpPath, '/new-server')
    })
    await test('directory discovered before SFTP is ready is used for initial navigation', async () => {
        const f = fixture()
        f.panel.sftp = undefined
        await f.cd('/initial')
        assert.equal(f.tab.sftpPath, '/initial')
        assert.deepEqual(f.calls, [])
    })
}
