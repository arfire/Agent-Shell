/* eslint-disable @typescript-eslint/no-unused-vars */
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { randomUUID } from 'crypto'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'
import * as russh from 'russh'

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private inner: russh.SFTPFile|null,
    ) { }

    async read (): Promise<Uint8Array> {
        if (!this.inner) {
            return Promise.resolve(new Uint8Array(0))
        }
        return this.inner.read(256 * 1024)
    }

    async write (chunk: Uint8Array): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await this.inner.writeAll(chunk)
    }

    async close (): Promise<void> {
        await this.inner?.shutdown()
        this.inner = null
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private logger: Logger

    constructor (private sftp: russh.SFTP, injector: Injector) {
        this.logger = injector.get(LogService).create('sftp')
        sftp.closed$.subscribe(() => {
            this.closed.next()
            this.closed.complete()
        })
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const entries = await this.sftp.readDirectory(p)
        return entries.map(entry => this._makeFile(
            posixPath.join(p, entry.name), entry,
        ))
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return this.sftp.readlink(p)
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await this.sftp.stat(p)
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.type === russh.SFTPFileType.Directory,
            isSymlink: stats.type === russh.SFTPFileType.Symlink,
            mode: stats.permissions ?? 0,
            size: stats.size,
            modified: new Date((stats.mtime ?? 0) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const handle = await this.sftp.open(p, mode)
        return new SFTPFileHandle(handle)
    }

    async rmdir (p: string): Promise<void> {
        await this.sftp.removeDirectory(p)
    }

    async mkdir (p: string): Promise<void> {
        await this.sftp.createDirectory(p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await this.sftp.rename(oldPath, newPath)
    }

    async unlink (p: string): Promise<void> {
        await this.sftp.removeFile(p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        await this.sftp.chmod(p, mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info(`Uploading into ${path}`)
        const tempPath = path + '.tabby-upload-' + randomUUID()
        let handle: SFTPFileHandle|undefined = undefined
        let written = 0
        try {
            transfer.setCompleted(false)
            transfer.setStatus(`Uploading to ${path}`)
            handle = await this.open(tempPath, russh.OPEN_WRITE | russh.OPEN_CREATE | russh.OPEN_TRUNCATE)
            while (true) {
                if (transfer.isCancelled()) {
                    throw new Error('Upload cancelled')
                }
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
                written += chunk.length
            }
            transfer.setStatus(`Finishing upload to ${path}`)
            await handle.close()
            handle = undefined
            if (transfer.isCancelled()) {
                throw new Error('Upload cancelled')
            }
            if (written !== transfer.getSize() || (await this.stat(tempPath)).size !== written) {
                throw new Error('Uploaded file size does not match the source')
            }
            await this.replaceUploadedFile(tempPath, path)
            if ((await this.stat(path)).size !== written) {
                throw new Error('Could not verify the uploaded file')
            }
            transfer.close()
            transfer.setCompleted(true)
            transfer.setStatus(`Uploaded to ${path}`)
        } catch (e) {
            transfer.setStatus(`Upload failed: ${path}: ${e.message ?? e}`)
            this.logger.error(`Upload failed: ${path}: ${e.message ?? e}`)
            if (!transfer.isCancelled()) {
                transfer.cancel()
            }
            await handle?.close().catch(() => null)
            await this.unlink(tempPath).catch(() => null)
            throw e
        }
    }

    private async replaceUploadedFile (tempPath: string, path: string): Promise<void> {
        try {
            await this.rename(tempPath, path)
            return
        } catch (error) {
            // Standard SFTP rename may refuse an existing target. Keep that target
            // recoverable until the replacement has been installed successfully.
            const existing = await this.stat(path).catch(() => null)
            if (!existing || existing.isDirectory) {
                throw error
            }
        }
        const backupPath = tempPath + '.backup'
        await this.rename(path, backupPath)
        try {
            await this.rename(tempPath, path)
        } catch (error) {
            try {
                await this.rename(backupPath, path)
            } catch (restoreError) {
                throw new Error(`${error.message ?? error}; original file preserved at ${backupPath}: ${restoreError.message ?? restoreError}`)
            }
            throw error
        }
        await this.unlink(backupPath).catch(error => {
            this.logger.warn(`Uploaded ${path}, but could not remove backup ${backupPath}: ${error.message ?? error}`)
        })
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        try {
            const handle = await this.open(path, russh.OPEN_READ)
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            transfer.close()
            handle.close()
        } catch (e) {
            transfer.cancel()
            throw e
        }
    }

    private _makeFile (p: string, entry: russh.SFTPDirectoryEntry): SFTPFile {
        return {
            fullPath: p,
            name: posixPath.basename(p),
            isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
            isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
            mode: entry.metadata.permissions ?? 0,
            size: entry.metadata.size,
            modified: new Date((entry.metadata.mtime ?? 0) * 1000),
        }
    }
}
