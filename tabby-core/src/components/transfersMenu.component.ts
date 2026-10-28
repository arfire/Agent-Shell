import { Component, Input, Output, EventEmitter, HostBinding, HostListener, ChangeDetectorRef } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { ConfigService } from '../services/config.service'
import { FileDownload, DirectoryDownload, FileTransfer, PlatformService } from '../api/platform'

/** @hidden */
@Component({
    selector: 'transfers-menu',
    templateUrl: './transfersMenu.component.pug',
    styleUrls: ['./transfersMenu.component.scss'],
})
export class TransfersMenuComponent {
    @Input() transfers: FileTransfer[]
    @Output() transfersChange = new EventEmitter<FileTransfer[]>()
    @HostBinding('class.vibrant') get isVibrant (): boolean {
        return this.config.store.appearance.vibrancy
    }

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private translate: TranslateService,
        private changeDetector: ChangeDetectorRef,
    ) { }

    @HostListener('window:resize')
    onResize (): void { this.changeDetector.markForCheck() }

    isDownload (transfer: FileTransfer): boolean {
        return transfer instanceof FileDownload || transfer instanceof DirectoryDownload
    }

    getProgress (transfer: FileTransfer): number {
        if (transfer.isComplete()) { return 100 }
        if (!transfer.getSize()) {
            return transfer.isComplete() ? 100 : 0
        }
        return Math.min(100, Math.max(0, Math.round(100 * transfer.getCompletedBytes() / transfer.getSize())))
    }

    isActive (transfer: FileTransfer): boolean {
        return !transfer.isComplete() && !transfer.isCancelled()
    }

    stateLabel (transfer: FileTransfer): string {
        if (transfer.getError()) { return '失败' }
        if (transfer.isCancelled()) { return '已取消' }
        if (transfer.isComplete()) { return '已完成' }
        return transfer.getCompletedBytes() || transfer.getStatus() ? '传输中' : '准备传输'
    }

    get activeCount (): number { return this.transfers.filter(t => this.isActive(t)).length }
    get finishedCount (): number { return this.transfers.length - this.activeCount }

    clearFinished (): void {
        this.transfers = this.transfers.filter(t => this.isActive(t))
        this.transfersChange.emit(this.transfers)
    }

    async cancelAll (): Promise<void> {
        if (!this.activeCount) { return }
        const result = await this.platform.showMessageBox({
            type: 'warning', message: '取消所有正在传输的文件？',
            detail: '已完成的文件会保留；未完成的任务将停止。',
            buttons: ['保留传输', '取消全部'], defaultId: 0, cancelId: 0,
        })
        if (result.response !== 1) { return }
        for (const transfer of this.transfers.filter(t => this.isActive(t))) { transfer.cancel() }
    }

    showTransfer (transfer: FileTransfer): void {
        const fp = transfer['filePath']
        if (fp) {
            this.platform.showItemInFolder(fp)
        }
    }

    removeTransfer (transfer: FileTransfer): void {
        if (this.isActive(transfer)) {
            transfer.cancel()
        }
        this.transfers = this.transfers.filter(x => x !== transfer)
        this.transfersChange.emit(this.transfers)
    }

    async removeAll (): Promise<void> {
        if (this.transfers.some(x => !x.isComplete())) {
            if ((await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('There are active file transfers'),
                buttons: [
                    this.translate.instant('Abort all'),
                    this.translate.instant('Do not abort'),
                ],
                defaultId: 1,
                cancelId: 1,
            })).response === 1) {
                return
            }
        }
        for (const t of this.transfers) {
            this.removeTransfer(t)
        }
    }
}
