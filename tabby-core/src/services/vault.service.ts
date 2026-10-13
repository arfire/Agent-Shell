import * as crypto from 'crypto'
import { promisify } from 'util'
import { Injectable, NgZone } from '@angular/core'
import { AsyncSubject, Subject, Observable } from 'rxjs'
import { wrapPromise } from '../utils'
import { SelectorService } from './selector.service'
import { FileProvider } from '../api/fileProvider'
import { PlatformService } from '../api/platform'

const PBKDF_ITERATIONS = 100000
const PBKDF_DIGEST = 'sha512'
const PBKDF_SALT_LENGTH = 64 / 8
const CRYPT_ALG = 'aes-256-cbc'
const CRYPT_KEY_LENGTH = 256 / 8
const CRYPT_IV_LENGTH = 128 / 8

export interface StoredVault {
    version: number
    /** Local automatic unlock; this is not protection against access to the data directory. */
    localKey?: string
    contents: string
    keySalt: string
    iv: string
}

export interface VaultSecret {
    type: string
    key: VaultSecretKey
    value: string
}

export interface VaultFileSecret extends VaultSecret {
    key: {
        id: string
        description: string
    }
}

export interface Vault {
    config: any
    secrets: VaultSecret[]
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface VaultSecretKey { }

function vaultContent (content: any): Vault {
    return {
        config: content.config,
        secrets: content.secrets ?? [],
    }
}

function deriveVaultKey (localKey: string, salt: Buffer): Promise<Buffer> {
    return promisify(crypto.pbkdf2)(
        Buffer.from(localKey),
        salt,
        PBKDF_ITERATIONS,
        CRYPT_KEY_LENGTH,
        PBKDF_DIGEST,
    )
}

async function encryptVault (content: Vault, localKey: string): Promise<StoredVault> {
    const keySalt = await promisify(crypto.randomBytes)(PBKDF_SALT_LENGTH)
    const iv = await promisify(crypto.randomBytes)(CRYPT_IV_LENGTH)
    const key = await deriveVaultKey(localKey, keySalt)

    const plaintext = JSON.stringify(content)
    const cipher = crypto.createCipheriv(CRYPT_ALG, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])

    return {
        version: 2,
        localKey,
        contents: encrypted.toString('base64'),
        keySalt: keySalt.toString('hex'),
        iv: iv.toString('hex'),
    }
}

async function decryptVault (vault: StoredVault): Promise<Vault> {
    if (vault.version !== 2) { throw new Error('不支持此凭据格式，原数据未改动。请在设置中重新配置凭据。') }
    if (!/^[a-f0-9]{64}$/.test(vault.localKey ?? '')) { throw new Error('本地凭据数据损坏，未覆盖原数据') }
    const keySalt = Buffer.from(vault.keySalt, 'hex')
    const key = await deriveVaultKey(vault.localKey!, keySalt)
    const iv = Buffer.from(vault.iv, 'hex')
    const encrypted = Buffer.from(vault.contents, 'base64')

    const decipher = crypto.createDecipheriv(CRYPT_ALG, key, iv)
    const plaintext = decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8')
    return vaultContent(JSON.parse(plaintext))
}

export const VAULT_SECRET_TYPE_FILE = 'file'

@Injectable({ providedIn: 'root' })
export class VaultService {
    /** Fires once when the config is loaded */
    get ready$ (): Observable<boolean> { return this.ready }

    get contentChanged$ (): Observable<void> { return this.contentChanged }

    store: StoredVault|null = null
    private ready = new AsyncSubject<boolean>()
    private contentChanged = new Subject<void>()
    private persist?: () => Promise<void>
    private enablePending?: Promise<void>
    private mutation = Promise.resolve()

    /** @hidden */
    private constructor (
        private zone: NgZone,
    ) {
        const addSecret = this.addSecret.bind(this)
        const updateSecret = this.updateSecret.bind(this)
        const removeSecret = this.removeSecret.bind(this)
        this.addSecret = secret => this.mutate(() => addSecret(secret))
        this.updateSecret = (secret, update) => this.mutate(() => updateSecret(secret, update))
        this.removeSecret = (type, key) => this.mutate(() => removeSecret(type, key))
    }

    private mutate (action: () => Promise<void>): Promise<void> {
        const pending = this.mutation.then(action)
        this.mutation = pending.catch(() => undefined)
        return pending
    }

    setPersistence (persist: () => Promise<void>): void {
        this.persist = persist
    }

    async ensureEnabled (): Promise<void> {
        await this.ready$.toPromise()
        if (this.isEnabled()) { return }
        if (!this.enablePending) {
            this.enablePending = (async () => {
                await this.setEnabled(true)
            })().finally(() => { this.enablePending = undefined })
        }
        return this.enablePending
    }

    async setEnabled (enabled: boolean): Promise<void> {
        if (enabled) {
            if (!this.store) {
                await this.save(vaultContent({}))
            }
        } else {
            const previous = this.store
            this.store = null
            try { await this.persist?.() } catch (error) { this.store = previous; throw error }
            this.contentChanged.next()
        }
    }

    isOpen (): boolean {
        return this.store?.version === 2
    }

    async decrypt (storage: StoredVault): Promise<Vault> {
        return wrapPromise(this.zone, decryptVault(storage))
    }

    async load (): Promise<Vault|null> {
        if (!this.store) {
            return null
        }
        return this.decrypt(this.store)
    }

    async encrypt (vault: Vault): Promise<StoredVault> {
        // Portable and deliberately passwordless: the unlock key travels with
        // the data, without OS credential storage or a machine-bound secret.
        const localKey = (await promisify(crypto.randomBytes)(32)).toString('hex')
        return wrapPromise(this.zone, encryptVault(vault, localKey))
    }

    async save (vault: Vault): Promise<void> {
        await this.ready$.toPromise()
        const previous = this.store
        this.store = await this.encrypt(vault)
        try { await this.persist?.() } catch (error) {
            this.store = previous
            throw error
        }
        this.contentChanged.next()
    }

    async getSecret (type: string, key: VaultSecretKey): Promise<VaultSecret|null> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return null
        }
        let vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        if (!vaultSecret) {
            // search for secret without host in vault (like a default user/password used in multiple servers)
            key['host'] = null
            vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        }
        return vaultSecret ?? null
    }

    async addSecret (secret: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            throw new Error('保险库尚未启用，凭证未保存')
        }
        vault.secrets = vault.secrets.filter(s => s.type !== secret.type || !this.keyMatches(secret.key, s))
        vault.secrets.push(secret)
        await this.save(vault)
    }

    async updateSecret (secret: VaultSecret, update: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        const target = vault.secrets.find(s => s.type === secret.type && this.keyMatches(secret.key, s))
        if (!target) {
            return
        }
        Object.assign(target, update)
        await this.save(vault)
    }

    async removeSecret (type: string, key: VaultSecretKey): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== type || !this.keyMatches(key, s))
        await this.save(vault)
    }

    private keyMatches (key: VaultSecretKey, secret: VaultSecret): boolean {
        return Object.keys(key).every(k => secret.key[k] === key[k])
    }

    setStore (store: StoredVault|null): void {
        // Only the current passwordless format participates in credential IO.
        // Loading an unsupported container must not block entering new keys.
        // The config on disk changes only when the user saves new credentials.
        this.store = store?.version === 2 ? store : null
        this.ready.next(true)
        this.ready.complete()
    }

    isEnabled (): boolean {
        return !!this.store
    }
}


@Injectable()
export class VaultFileProvider extends FileProvider {
    name = 'Vault'
    prefix = 'vault://'

    constructor (
        private vault: VaultService,
        private platform: PlatformService,
        private selector: SelectorService,
        private zone: NgZone,
    ) {
        super()
    }

    async isAvailable (): Promise<boolean> {
        return this.vault.isEnabled()
    }

    async selectAndStoreFile (description: string): Promise<string> {
        const vault = await this.vault.load()
        if (!vault) {
            throw new Error('本地凭据保存尚未启用')
        }
        const files = vault.secrets.filter(x => x.type === VAULT_SECRET_TYPE_FILE) as VaultFileSecret[]
        if (files.length) {
            const result = await this.selector.show<VaultFileSecret|null>('Select file', [
                {
                    name: 'Add a new file',
                    icon: 'fas fa-plus',
                    result: null,
                },
                ...files.map(f => ({
                    name: f.key.description,
                    icon: 'fas fa-file',
                    result: f,
                })),
            ]).catch(() => null)
            if (result) {
                return `${this.prefix}${result.key.id}`
            }
        }
        return this.addNewFile(description)
    }

    async addNewFile (description: string): Promise<string> {
        const transfers = await this.platform.startUpload()
        if (!transfers.length) {
            throw new Error('Nothing selected')
        }
        const transfer = transfers[0]
        const id = (await wrapPromise(this.zone, promisify(crypto.randomBytes)(32))).toString('hex')
        await this.vault.addSecret({
            type: VAULT_SECRET_TYPE_FILE,
            key: {
                id,
                description: `${description} (${transfer.getName()})`,
            },
            value: Buffer.from(await transfer.readAll()).toString('base64'),
        })
        return `${this.prefix}${id}`
    }

    async retrieveFile (key: string): Promise<Buffer> {
        if (!key.startsWith(this.prefix)) {
            throw new Error('Incorrect type')
        }
        const secret = await this.vault.getSecret(VAULT_SECRET_TYPE_FILE, { id: key.substring(this.prefix.length) })
        if (!secret) {
            throw new Error('Not found')
        }
        return Buffer.from(secret.value, 'base64')
    }
}
