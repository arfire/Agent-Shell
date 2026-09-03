#!/usr/bin/env node
import path from 'node:path'
import { promisify } from 'node:util'
import webpack from 'webpack'
import log from 'npmlog'
import spawn from 'cross-spawn'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function parseArgs () {
    const args = process.argv.slice(2)
    const result = {
        app: false,
        production: false,
        typings: true,
        plugins: [],
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--app') {
            result.app = true
            continue
        }
        if (arg === '--production') {
            result.production = true
            continue
        }
        if (arg === '--no-typings') {
            result.typings = false
            continue
        }
        if (arg === '--plugins') {
            if (!args[i + 1]) {
                throw new Error('--plugins requires a comma-separated plugin list')
            }
            result.plugins = args[++i]
                .split(',')
                .map(item => item.trim())
                .filter(Boolean)
            continue
        }
        throw new Error(`Unknown option: ${arg}`)
    }
    if (!result.plugins.length) {
        result.plugins = ['tabby-terminal', 'tabby-ai']
    }
    for (const plugin of result.plugins) {
        if (!/^tabby-[a-z0-9-]+$/.test(plugin) && !['web', 'tabby-web-demo'].includes(plugin)) {
            throw new Error(`Invalid package name for fast build: ${plugin}`)
        }
    }
    return result
}

function run (command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: repoRoot,
            stdio: 'inherit',
        })
        child.on('exit', code => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`))
            }
        })
        child.on('error', reject)
    })
}

async function buildWebpackConfig (configPath) {
    log.info('build', configPath)
    const config = (await import(configPath)).default()
    const stats = await promisify(webpack)(config)
    console.log(stats.toString({ colors: true }))
    if (stats.hasErrors()) {
        throw new Error(`${configPath} completed with webpack errors`)
    }
}

async function main () {
    const options = parseArgs()
    if (options.production) {
        delete process.env.TABBY_DEV
    } else {
        process.env.TABBY_DEV = process.env.TABBY_DEV || '1'
    }

    if (options.typings) {
        for (const plugin of options.plugins) {
            log.info('typings', plugin)
            await run('yarn', ['tsc', '--project', `${plugin}/tsconfig.typings.json`])
        }
    }

    if (options.app) {
        await buildWebpackConfig('../app/webpack.config.main.mjs')
        await buildWebpackConfig('../app/webpack.config.mjs')
    }

    for (const plugin of options.plugins) {
        await buildWebpackConfig(`../${plugin}/webpack.config.mjs`)
    }
}

main().catch(error => {
    log.error('build-fast', String(error))
    process.exit(1)
})
