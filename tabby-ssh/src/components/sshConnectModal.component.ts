import { Component, OnDestroy } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, FileProvidersService, PartialProfile, ProfilesService } from 'tabby-core'
import { SSHProfile } from '../api'
import { PasswordStorageService } from '../services/passwordStorage.service'

@Component({
    templateUrl: './sshConnectModal.component.pug',
})
export class SSHConnectModalComponent implements OnDestroy {
    host = ''
    port = 22
    user = ''
    auth: SSHProfile['options']['auth'] = 'password'
    password = ''
    privateKey = ''
    address = ''
    showAddress = false
    saveConnection = false
    rememberPassword = false
    name = ''
    busy = false
    error = ''

    constructor (
        public modal: NgbActiveModal,
        private profiles: ProfilesService,
        private config: ConfigService,
        private passwords: PasswordStorageService,
        private files: FileProvidersService,
    ) { }

    ngOnDestroy (): void { this.password = '' }

    get valid (): boolean {
        return !!this.normalizedHost() && !!this.user.trim() && !/[\s\x00-\x1f]/.test(this.user) &&
            Number.isInteger(this.port) && this.port >= 1 && this.port <= 65535 &&
            (this.auth !== 'publicKey' || !!this.privateKey)
    }

    private normalizedHost (): string {
        const value = this.host.trim().replace(/^\[|\]$/g, '')
        if (!value || /[\s/@\\;?#]/.test(value)) { return '' }
        try {
            const url = new URL('ssh://' + (value.includes(':') ? '[' + value + ']' : value))
            return url.hostname.replace(/^\[|\]$/g, '')
        } catch { return '' }
    }

    parseAddress (): void {
        this.error = ''
        try {
            const url = new URL(this.address.includes('://') ? this.address.trim() : 'ssh://' + this.address.trim())
            if (url.protocol !== 'ssh:' || url.password || !url.hostname || url.pathname && url.pathname !== '/') {
                throw new Error('请粘贴 SSH 地址；密码请在密码框中填写。')
            }
            this.host = url.hostname.replace(/^\[|\]$/g, '')
            this.user = decodeURIComponent(url.username) || this.user
            this.port = url.port ? Number(url.port) : 22
            if (!this.normalizedHost() || this.port < 1 || this.port > 65535) { throw new Error('主机或端口无效。') }
            this.showAddress = false
        } catch (error) {
            this.error = error instanceof Error ? error.message : '地址格式无效。'
        }
    }

    async chooseKey (): Promise<void> {
        const ref = await this.files.selectAndStoreFile('SSH 私钥').catch(() => null)
        if (ref) { this.privateKey = ref }
    }

    async connect (): Promise<void> {
        if (!this.valid || this.busy) { return }
        this.busy = true
        this.error = ''
        const profile: PartialProfile<SSHProfile> = {
            id: 'ssh:' + crypto.randomUUID(),
            type: 'ssh',
            name: this.name.trim() || this.user.trim() + '@' + this.normalizedHost(),
            options: {
                host: this.normalizedHost(), port: this.port, user: this.user.trim(), auth: this.auth,
                privateKeys: this.privateKey ? [this.privateKey] : [], reuseSession: false,
            },
        }
        try {
            if (this.saveConnection && this.rememberPassword && this.password && this.auth === 'password') {
                await this.passwords.savePassword(this.profiles.getConfigProxyForProfile(profile), this.password)
            }
            if (this.saveConnection) {
                this.config.store.profiles = [...this.config.store.profiles, { ...profile, options: { ...profile.options } }]
                try { await this.config.save() } catch (error) {
                    this.config.store.profiles = this.config.store.profiles.filter(p => p.id !== profile.id)
                    throw error
                }
            }
            // Passwords belong to the live connection or keychain, never the saved YAML.
            if (this.auth === 'password' && this.password) { profile.options!.password = this.password }
            this.password = ''
            this.modal.close(profile)
        } catch (error) {
            this.error = '无法保存连接：' + (error instanceof Error ? error.message : String(error))
        } finally { this.busy = false }
    }
}
