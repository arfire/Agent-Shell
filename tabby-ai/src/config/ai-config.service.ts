import { Injectable } from '@angular/core'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as remote from '@electron/remote'
import { LogService, Logger } from 'tabby-core'
import { Subject } from 'rxjs'

import { AIConfig, validateAIConfig } from './config-schema'

@Injectable({ providedIn: 'root' })
export class AIConfigService {
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

    constructor (log: LogService) {
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
