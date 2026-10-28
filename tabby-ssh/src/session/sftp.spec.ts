import * as assert from 'node:assert/strict'
import { OPEN_READ, type SFTP } from 'russh'
import type { SFTPSession } from './sftp'

export async function runTests (
    test: (name: string, run: () => Promise<void>) => Promise<void>,
    load: (file: string) => any,
    sftp: SFTPSession,
    native: SFTP,
): Promise<void> {
    const { FileUpload, FileDownload } = load('tabby-core/src/api/platform.ts') as typeof import('tabby-core')
    class Upload extends FileUpload {
        offset = 0
        closed = false
        constructor (public readonly data: Uint8Array) { super() }
        getName (): string { return 'upload.bin' }
        getSize (): number { return this.data.length }
        getMode (): number { return 0o644 }
        close (): void { this.closed = true }
        async read (): Promise<Uint8Array> {
            const chunk = this.data.slice(this.offset, this.offset + 256 * 1024)
            this.offset += chunk.length
            this.increaseProgress(chunk.length)
            assert.equal(this.isComplete(), false, 'Reading source cannot confirm remote completion')
            return chunk
        }
    }

    for (const size of [0, 15, 700000]) {
        await test(`SFTP uploads and reads back ${size} bytes`, async () => {
            const data = Uint8Array.from({ length: size }, (_, i) => i % 251)
            const transfer = new Upload(data)
            assert.equal(transfer.isComplete(), false)
            const destination = `/tmp/ash-upload-${size}.bin`
            await sftp.upload(destination, transfer)
            assert.equal(transfer.isComplete(), true)
            assert.equal(transfer.closed, true)
            assert.equal((await sftp.stat(destination)).size, size)
            const handle = await sftp.open(destination, OPEN_READ)
            const chunks: Uint8Array[] = []
            try {
                while (true) {
                    const chunk = await handle.read()
                    if (!chunk.length) { break }
                    chunks.push(chunk)
                }
            } finally {
                await handle.close()
            }
            assert.deepEqual(Buffer.concat(chunks), Buffer.from(data))
        })
    }

    class Download extends FileDownload {
        chunks: Uint8Array[] = []
        closed = false
        constructor (private size: number) { super() }
        getName (): string { return 'download.bin' }
        getSize (): number { return this.size }
        close (): void { this.closed = true }
        async write (data: Uint8Array): Promise<void> { this.chunks.push(data); this.increaseProgress(data.length) }
    }
    for (const size of [0, 15, 700000]) {
        await test(`SFTP downloads ${size} bytes exactly`, async () => {
            const transfer = new Download(size)
            await sftp.download(`/tmp/ash-upload-${size}.bin`, transfer)
            assert.deepEqual(Buffer.concat(transfer.chunks), Buffer.from(Uint8Array.from({ length: size }, (_, i) => i % 251)))
            assert.equal(transfer.closed, true)
            assert.equal(transfer.isComplete(), true)
            assert.equal(transfer.getError(), '')
        })
    }
    await test('SFTP missing download records a readable failure', async () => {
        const transfer = new Download(1)
        await assert.rejects(sftp.download('/tmp/ash-absent.bin', transfer))
        assert.equal(transfer.isComplete(), false)
        assert.ok(transfer.getError())
    })
    await test('SFTP cancelled download writes no further bytes', async () => {
        const transfer = new Download(700000)
        transfer.cancel()
        await assert.rejects(sftp.download('/tmp/ash-upload-700000.bin', transfer), /cancelled/)
        assert.equal(transfer.chunks.length, 0)
        assert.equal(transfer.isComplete(), false)
        assert.equal(transfer.getError(), '')
    })

    await test('SFTP permission failure never reports completion', async () => {
        const transfer = new Upload(new Uint8Array([1, 2, 3]))
        await assert.rejects(sftp.upload('/root/ash-denied.bin', transfer))
        assert.equal(transfer.isComplete(), false)
        assert.equal(transfer.isCancelled(), true)
        assert.match(transfer.getError(), /权限不足/)
    })

    await test('SFTP final rename failure stays failed after all source bytes are read', async () => {
        const transfer = new Upload(new Uint8Array([1, 2, 3]))
        const rename = native.rename.bind(native)
        native.rename = async () => { throw new Error('Injected rename failure') }
        try {
            await assert.rejects(sftp.upload('/tmp/ash-rename-failed.bin', transfer), /Injected rename failure/)
            assert.equal(transfer.getCompletedBytes(), 3)
            assert.equal(transfer.isComplete(), false)
            assert.equal(transfer.isCancelled(), true)
            assert.ok(transfer.getError())
            assert.equal((await sftp.readdir('/tmp')).some(file => file.name.startsWith('ash-rename-failed.bin')), false)
        } finally {
            native.rename = rename
        }
    })

    await test('SFTP overwrites a larger file without stale trailing bytes', async () => {
        const destination = '/tmp/ash-overwrite.bin'
        await sftp.upload(destination, new Upload(new Uint8Array(900)))
        await sftp.upload(destination, new Upload(new Uint8Array([7, 8])))
        assert.equal((await sftp.stat(destination)).size, 2)
    })

    await test('SFTP replacement failure restores the original file', async () => {
        const destination = '/tmp/ash-preserve.bin'
        await sftp.upload(destination, new Upload(new Uint8Array([9, 8, 7])))
        const rename = native.rename.bind(native)
        native.rename = async (source, target) => {
            if (source.includes('.tabby-upload-') && !source.endsWith('.backup') && target === destination) {
                throw new Error('Injected replacement failure')
            }
            return rename(source, target)
        }
        try {
            await assert.rejects(sftp.upload(destination, new Upload(new Uint8Array([1]))), /Injected replacement failure/)
            const handle = await sftp.open(destination, OPEN_READ)
            try { assert.deepEqual(Buffer.from(await handle.read()), Buffer.from([9, 8, 7])) } finally { await handle.close() }
        } finally {
            native.rename = rename
        }
    })
}
