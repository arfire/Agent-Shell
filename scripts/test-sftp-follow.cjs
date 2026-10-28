/* Deterministic delayed-directory regression tests; no server or credentials. */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('../node_modules/typescript')
const rx = require('../node_modules/rxjs')
const root = path.resolve(__dirname, '..')
class SSHTabComponent {}
const decorator = () => () => undefined
function load (file) {
    const module = { exports: {} }
    const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
    const localRequire = id => {
        if (id === './sftpPanel.component') return load('tabby-ssh/src/components/sftpPanel.component.ts')
        if (id === './workspaceFiles.component') return load('tabby-ssh/src/components/workspaceFiles.component.ts')
        if (id === '@angular/core') return { Component: decorator, Injectable: decorator, Input: decorator, Output: decorator, ViewChild: decorator, Inject: decorator, Optional: decorator, EventEmitter: rx.Subject }
        if (id === 'tabby-core') return { WorkspacePanelProvider: class {} }
        if (id === './sshTab.component') return { SSHTabComponent }
        if (id.startsWith('.') || id === '@ng-bootstrap/ng-bootstrap') return {}
        return require(id)
    }
    vm.runInThisContext('(function(require,module,exports,window){' + source + '\n})', { filename: file })(localRequire, module, module.exports, { localStorage: {} })
    return module.exports
}
async function main () {
    let count = 0
    const test = async (name, run) => { await run(); console.log('PASS', name); count++ }
    await load('tabby-ssh/src/components/workspaceFiles.component.spec.ts').runTests(test)
    console.log(count + ' SFTP follow regression checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
