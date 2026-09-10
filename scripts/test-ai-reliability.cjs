/* Isolated regression runner: yarn test:ai-reliability (Node 22). */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('../node_modules/typescript')
const root = path.resolve(__dirname, '..')
const cache = new Map()
function load (filename) {
    filename = path.resolve(root, filename)
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
    const localRequire = id => {
        if (id === '@angular/core') return { Injectable: () => value => value }
        if (id === 'tabby-core') return {}
        if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id + '.ts'))
        return require(id)
    }
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(localRequire, module, module.exports)
    return module.exports
}
async function main () {
    let total = 0
    const test = async (name, run) => { await run(); total++; console.log('PASS', name) }
    await load('tabby-ai/src/session/session-store.spec.ts').runTests(test, load)
    await load('tabby-ai/src/llm/model-compatibility.spec.ts').runTests(test, load)
    await load('tabby-ai/src/web/web.spec.ts').runTests(test, load)
    console.log(`${total} AI reliability checks passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
