import * as path from 'path'
import * as fs from 'fs'

process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : (process.env.ARCH || process.arch)

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const electronInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../node_modules/electron/package.json')))
const productVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../version.json')))

export const tabbyVersion = productVersion.tabby
export const ashVersion = productVersion.ash
export const version = ashVersion
export const displayVersion = `Ash ${ashVersion} (Tabby ${tabbyVersion})`
process.env.TABBY_VERSION = tabbyVersion
process.env.ASH_VERSION = ashVersion

export const builtinPlugins = [
    'tabby-core',
    'tabby-settings',
    'tabby-terminal',
    'tabby-web',
    'tabby-community-color-schemes',
    'tabby-ssh',
    'tabby-serial',
    'tabby-telnet',
    'tabby-local',
    'tabby-electron',
    'tabby-plugin-manager',
    'tabby-linkifier',
    'tabby-auto-sudo-password',
    'tabby-ai',
]

export const packagesWithDocs = [
    ['.', 'tabby-core'],
    ['terminal', 'tabby-terminal'],
    ['local', 'tabby-local'],
    ['settings', 'tabby-settings'],
]

export const allPackages = [
    ...builtinPlugins,
    'web',
    'tabby-web-demo',
]

export const bundledModules = [
    '@angular',
    '@ng-bootstrap',
]
export const electronVersion = electronInfo.version
