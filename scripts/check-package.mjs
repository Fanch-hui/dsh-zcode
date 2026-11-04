import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const targets = Object.values(manifest.exports).flatMap(entry => typeof entry === 'string' ? [entry] : Object.values(entry))
targets.push(...Object.values(manifest.bin ?? {}))
await Promise.all(targets.map(target => access(new URL(target, root))))
await Promise.all(['cordis.patch.yml', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'lib/cli/THIRD_PARTY_LICENSES.txt'].map(path => access(new URL(path, root))))
const host = await import(new URL(manifest.main, root))
assert.equal(typeof host.apply, 'function')
assert.equal(host.name, 'llm-zcode')
assert.ok(host.Config)
const { TYPERT, contribution } = await import(new URL(manifest.exports['./remote'].default, root))
assert.equal(TYPERT.package, manifest.name)
assert.deepEqual(TYPERT.invocations, contribution.descriptors)
let registration
const client = await readFile(new URL(manifest.exports['./client'], root), 'utf8')
runInNewContext(client, { window: { __ModuleLoader__: { load(value) { registration = value } } } }, { timeout: 1000 })
assert.equal(registration?.id, manifest.name)
assert.equal(typeof registration?.factory, 'function')
assert.ok(!client.includes('node:crypto') && !client.includes('oauthAccessToken'), 'browser bundle must contain only the client face')
console.log('Package entries, Host exports, Typert descriptors and browser factory verified.')
