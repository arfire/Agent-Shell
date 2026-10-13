import * as keytar from 'keytar'
import { Injectable } from '@angular/core'
import { VaultService } from 'tabby-core'
import { SSHProfile } from '../api'

export const VAULT_SECRET_TYPE_PASSWORD = 'ssh:password'
export const VAULT_SECRET_TYPE_PASSPHRASE = 'ssh:key-passphrase'

@Injectable({ providedIn: 'root' })
export class PasswordStorageService {
    constructor (private vault: VaultService) { }

    private get portable (): boolean {
        return !!(process.env.PORTABLE_EXECUTABLE_DIR ?? process.env.TABBY_DATA_DIRECTORY)
    }

    async savePassword (profile: SSHProfile, password: string, username?: string): Promise<void> {
        if (this.portable) { await this.vault.ensureEnabled() }
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            await this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSWORD, key, value: password })
        } else {
            if (!account) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            return keytar.setPassword(key, account, password)
        }
    }

    async deletePassword (profile: SSHProfile, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            await this.vault.removeSecret(VAULT_SECRET_TYPE_PASSWORD, key)
        } else if (!this.portable) {
            if (!account) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            await keytar.deletePassword(key, account)
        }
    }

    async loadPassword (profile: SSHProfile, username?: string): Promise<string|null> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            let saved: Awaited<ReturnType<VaultService['getSecret']>> = null
            try { saved = await this.vault.getSecret(VAULT_SECRET_TYPE_PASSWORD, key) } catch { return null }
            return saved?.value || null
        }
        if (this.portable) { return null }
        {
            if (!account) {
                return null
            }
            const key = this.getKeytarKeyForConnection(profile)
            try {
                return await keytar.getPassword(key, account)
            } catch (e) {
                console.warn(`Failed to load stored password for ${account}@${profile.options.host}:${profile.options.port ?? 22}`, e)
                return null
            }
        }
    }

    async savePrivateKeyPassword (id: string, password: string): Promise<void> {
        if (this.portable) { await this.vault.ensureEnabled() }
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            await this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSPHRASE, key, value: password })
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.setPassword(key, 'user', password)
        }
    }

    async deletePrivateKeyPassword (id: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            await this.vault.removeSecret(VAULT_SECRET_TYPE_PASSPHRASE, key)
        } else if (!this.portable) {
            const key = this.getKeytarKeyForPrivateKey(id)
            await keytar.deletePassword(key, 'user')
        }
    }

    async loadPrivateKeyPassword (id: string): Promise<string|null> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            let saved: Awaited<ReturnType<VaultService['getSecret']>> = null
            try { saved = await this.vault.getSecret(VAULT_SECRET_TYPE_PASSPHRASE, key) } catch { return null }
            return saved?.value || null
        }
        if (this.portable) { return null }
        const key = this.getKeytarKeyForPrivateKey(id)
        return keytar.getPassword(key, 'user')
    }

    private getKeytarKeyForConnection (profile: SSHProfile): string {
        let key = `ssh@${profile.options.host}`
        if (profile.options.port) {
            key = `ssh@${profile.options.host}:${profile.options.port}`
        }
        return key
    }

    private getKeytarKeyForPrivateKey (id: string): string {
        return `ssh-private-key:${id}`
    }

    private getVaultKeyForConnection (profile: SSHProfile, username?: string) {
        return {
            user: username ?? profile.options.user,
            host: profile.options.host,
            port: profile.options.port,
        }
    }

    private getVaultKeyForPrivateKey (id: string) {
        return { hash: id }
    }
}
