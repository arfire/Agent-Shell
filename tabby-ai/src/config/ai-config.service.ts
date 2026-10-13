import { Injectable } from '@angular/core'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as remote from '@electron/remote'
import { ConfigService, LogService, Logger, VaultService } from 'tabby-core'
import { randomUUID } from 'crypto'
import { Subject } from 'rxjs'

import { AIConfig, validateAIConfig } from './config-schema'


function mergeConfig<T> (defaults: T, user: unknown): T {
    if (Array.isArray(defaults)) {
        return (Array.isArray(user) ? user : defaults) as T
    }
    if (!defaults || typeof defaults !== 'object') {
        return (user === undefined ? defaults : user) as T
    }
    const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
        return result as T
    }
    for (const [key, value] of Object.entries(user as Record<string, unknown>)) {
        result[key] = key in result ? mergeConfig(result[key], value) : value
    }
    return result as T
}


@Injectable({ providedIn: 'root' })
export class AIConfigService {
    readonly knownSecrets = new Set<string>()
    readonly directory: string
    readonly configPath: string
    readonly defaultConfigPath: string
    readonly ready: Promise<void>
    readonly changed = new Subject<void>()

    config: AIConfig
    loadError: string|null = null

    private logger: Logger
    private defaults: AIConfig
    private writes = Promise.resolve()

    constructor (log: LogService, public vault: VaultService, coreConfig: ConfigService) {
        // Ensure the existing vault's persistence callback is installed.
        void coreConfig
        this.logger = log.create('aiConfig')
        this.directory = path.join(remote.app.getPath('userData'), 'tabby-ai')
        this.configPath = path.join(this.directory, 'config.yaml')
        this.defaultConfigPath = path.join(this.directory, 'config.default.yaml')
        this.ready = this.initialize()
    }

    async save (config: AIConfig): Promise<void> {
        validateAIConfig(config)
        const snapshot = JSON.parse(JSON.stringify(config)) as AIConfig
        const write = this.writes.catch(() => undefined).then(async () => {
            for (const [object, key, label] of this.credentialFields(snapshot)) {
                const value = object[key]
                if (!value || this.isCredentialReference(value)) { continue }
                await this.vault.ensureEnabled()
                const id = randomUUID()
                await this.vault.addSecret({ type: 'ai:credential', key: { id, description: label }, value })
                this.knownSecrets.add(value)
                object[key] = `ash-vault:${id}`
            }
            await fs.promises.mkdir(this.directory, { recursive: true })
            const temporaryPath = `${this.configPath}.tmp`
            await fs.promises.writeFile(temporaryPath, yaml.dump(snapshot, { noRefs: true, lineWidth: 120 }), 'utf8')
            await fs.promises.rename(temporaryPath, this.configPath)
            this.config = snapshot
            this.loadError = null
            this.changed.next()
        })
        this.writes = write
        await write
    }

    isCredentialReference (value: string): boolean {
        return value.startsWith('ash-vault:')
    }

    async protectStoredCredentials (): Promise<void> {
        await this.ready
        if (this.credentialFields(this.config).some(([object, key]) => object[key] && !this.isCredentialReference(object[key]))) {
            await this.save(this.config)
        }
    }

    async clearUnavailableReferences (config: AIConfig): Promise<string[]> {
        const missing: string[] = []
        for (const [object, key, label] of this.credentialFields(config)) {
            if (!this.isCredentialReference(object[key] ?? '')) { continue }
            try { await this.resolveSecret(object[key]) } catch {
                object[key] = ''
                missing.push(label)
            }
        }
        return missing
    }

    async resolveSecret (value: string): Promise<string> {
        if (!this.isCredentialReference(value)) { return value }
        const secret = await this.vault.getSecret('ai:credential', { id: value.substring('ash-vault:'.length) })
        if (!secret) { throw new Error('已保存的凭证不存在，请在设置中重新填写') }
        this.knownSecrets.add(secret.value)
        return secret.value
    }

    async saveAgentCredential (value: string, description: string): Promise<string> {
        await this.vault.ensureEnabled()
        const id = randomUUID()
        await this.vault.addSecret({ type: 'ai:agent-credential', key: { id, description }, value })
        this.knownSecrets.add(value)
        return `ash-vault:${id}`
    }

    async loadAgentCredential (reference: string): Promise<string> {
        const secret = await this.vault.getSecret('ai:agent-credential', { id: reference.replace(/^ash-vault:/, '') })
        if (!secret) { throw new Error('凭证已不存在，请重新输入') }
        this.knownSecrets.add(secret.value)
        return secret.value
    }

    async listAgentCredentials (): Promise<{ reference: string, description: string }[]> {
        const contents = await this.vault.load()
        return (contents?.secrets ?? []).filter(secret => secret.type === 'ai:agent-credential').map(secret => ({
            reference: `ash-vault:${(secret.key as { id: string }).id}`,
            description: (secret.key as { description: string }).description,
        }))
    }

    private credentialFields (config: AIConfig): [Record<string, any>, string, string][] {
        return [
            [config.llm, 'apiKey', 'Agent 模型 API Key'],
            ...config.web ? [
                [config.web.model, 'apiKey', '联网模型 API Key'],
                [config.web, 'authorization', '搜索服务认证'],
            ] as [Record<string, any>, string, string][] : [],
        ]
    }

    async getDefaults (): Promise<AIConfig> {
        await this.ready
        return JSON.parse(JSON.stringify(this.defaults)) as AIConfig
    }

    private async initialize (): Promise<void> {
        await fs.promises.mkdir(this.directory, { recursive: true })
        const defaults = await this.loadDefaults()
        this.defaults = defaults
        let loaded: unknown = defaults

        // Keep an untouched, user-visible reference beside the editable file.
        // It is deliberately not overwritten on upgrades so users can always
        // recover the baseline that accompanied their first Ash launch.
        if (!fs.existsSync(this.defaultConfigPath)) {
            await fs.promises.writeFile(
                this.defaultConfigPath,
                yaml.dump(defaults, { noRefs: true, lineWidth: 120 }),
                'utf8',
            )
        }

        if (!fs.existsSync(this.configPath)) {
            await this.save(defaults)
        } else {
            try {
                loaded = yaml.load(await fs.promises.readFile(this.configPath, 'utf8'))
                loaded = mergeConfig(defaults, loaded)
                validateAIConfig(loaded)
            } catch (error) {
                this.loadError = String(error)
                this.logger.error('Could not load config.yaml, using safe defaults:', error)
                loaded = defaults
            }
        }

        validateAIConfig(loaded)
        this.config = loaded
    }

    private async loadDefaults (): Promise<AIConfig> {
        const candidates = [
            path.resolve(__dirname, '../default-config.yaml'),
            path.resolve(__dirname, '../../default-config.yaml'),
            path.resolve(__dirname, '../../../default-config.yaml'),
        ]
        const defaultPath = candidates.find(candidate => fs.existsSync(candidate))
        if (!defaultPath) {
            throw new Error('tabby-ai/default-config.yaml was not found')
        }
        const defaults = yaml.load(await fs.promises.readFile(defaultPath, 'utf8'))
        validateAIConfig(defaults)
        return defaults
    }
}
