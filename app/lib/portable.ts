import * as path from 'path'
import * as fs from 'fs'
import * as electron from 'electron'

const appPath = path.dirname(electron.app.getPath('exe'))
const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR ?? appPath
const portableData = path.resolve(process.env.TABBY_DATA_DIRECTORY ?? path.join(portableRoot, 'data'))
const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_DIR ||
    process.platform === 'win32' && electron.app.isPackaged
const usePortableData = !!process.env.TABBY_DATA_DIRECTORY || isPortableBuild || fs.existsSync(portableData)

// Ash's Windows deliverable is a portable ZIP. It creates data beside the
// executable on first launch. Development retains Tabby's existing opt-in
// behavior so local source runs do not unexpectedly change their profile.
if (usePortableData) {
    // electron-builder only provides these variables for its "portable"
    // target. Ash uses a ZIP target, so expose the same contract ourselves.
    // Renderer-side services then disable installer-only updates and relaunch
    // the executable from the portable directory.
    if (isPortableBuild) {
        process.env.PORTABLE_EXECUTABLE_DIR ??= portableRoot
        process.env.PORTABLE_EXECUTABLE_FILE ??= electron.app.getPath('exe')
    }
    fs.mkdirSync(portableData, { recursive: true })
    const logsDirectory = path.join(portableData, 'logs')
    const crashDumpsDirectory = path.join(portableData, 'Crashpad')
    fs.mkdirSync(logsDirectory, { recursive: true })
    fs.mkdirSync(crashDumpsDirectory, { recursive: true })
    console.log('reset user data to ' + portableData)
    electron.app.setPath('userData', portableData)
    electron.app.setPath('sessionData', portableData)
    electron.app.setPath('logs', logsDirectory)
    electron.app.setPath('crashDumps', crashDumpsDirectory)
}
