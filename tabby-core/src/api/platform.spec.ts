import * as assert from 'node:assert/strict'
import { DirectoryDownload, FileDownload } from './platform'

export async function runTests (test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
    class File extends FileDownload {
        closes = 0
        getName (): string { return 'child.bin' }
        getSize (): number { return 20 }
        close (): void { this.closes++ }
        async write (data: Uint8Array): Promise<void> { this.increaseProgress(data.length) }
    }
    class Folder extends DirectoryDownload {
        closes = 0
        getName (): string { return 'folder' }
        getSize (): number { return this.getTotalSize() }
        close (): void { this.closes++ }
        async createDirectory (): Promise<void> { return }
        async createFile (): Promise<FileDownload> { return new File() }
    }
    await test('directory downloads stay active before size discovery and aggregate child bytes', async () => {
        const folder = new Folder(), file = new File()
        assert.equal(folder.isComplete(), false)
        folder.setTotalSize(20)
        const untrack = folder.trackFile(file)
        await file.write(new Uint8Array(12))
        assert.equal(folder.getCompletedBytes(), 12)
        assert.equal(Number.isFinite(folder.getSpeed()), true)
        assert.equal(folder.isComplete(), false)
        untrack()
        await file.write(new Uint8Array(8))
        assert.equal(folder.getCompletedBytes(), 12)
        folder.setCompleted(true)
        assert.equal(folder.isComplete(), true)
    })
    await test('directory cancellation stops the current child and repeated cancellation closes once', async () => {
        const folder = new Folder(), file = new File()
        const untrack = folder.trackFile(file)
        folder.cancel(); folder.cancel(); file.cancel()
        assert.equal(folder.isCancelled(), true)
        assert.equal(file.isCancelled(), true)
        assert.equal(folder.closes, 1)
        assert.equal(file.closes, 1)
        untrack()
    })
}
