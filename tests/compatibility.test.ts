import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

test('the native DSH installer accepts the supported alpha and current release candidate', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(getDshRuntimeVersion(), '0.2.2-rc.1')
  for (const version of ['0.2.2-alpha.3', getDshRuntimeVersion()]) {
    assert.equal(evaluatePluginCompatibility(manifest, undefined, version), undefined)
  }
  assert.ok(evaluatePluginCompatibility(manifest, undefined, '0.2.1-rc.5'))
  assert.ok(evaluatePluginCompatibility(manifest, undefined, '0.3.0'))
})
