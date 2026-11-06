import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { TYPERT } from '../src/control/remote.js'
import { statusSchema } from '../src/control/remote.js'
import * as plugin from '../src/index.js'

test('the native Host mounts providers against loader-owned Typert and disposes them cleanly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-zcode-host-test-'))
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
    ctx.provide('profileContext', { dir: join(home, 'profiles', 'desktop') })
    ctx.provide('attachments', { readImage: async () => { throw new Error('no image requested') } })
    ctx.typert.register(TYPERT)
    const fiber = await ctx.plugin(plugin, {})
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id).sort(), [
      'zcode-bigmodel', 'zcode-bigmodel-start-plan', 'zcode-zai', 'zcode-zai-start-plan',
    ])
    const coding = ['GLM-5.3', 'GLM-5.3-Flash']
    const start = ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5.3']
    for (const platform of ['bigmodel', 'zai']) {
      assert.deepEqual((await ctx.llm.listModels(`zcode-${platform}`)).map(model => model.id), coding)
      assert.deepEqual((await ctx.llm.listModels(`zcode-${platform}-start-plan`)).map(model => model.id), start)
      assert.equal((await ctx.llm.resolveModelInfo(`zcode-${platform}-start-plan`, 'GLM-5.3')).id, 'GLM-5.3')
      assert.equal((await ctx.llm.resolveModelInfo(`zcode-${platform}`, 'GLM-5.2')).id, 'GLM-5.2')
    }
    const control = ctx.get('zcode') as { status(): Promise<unknown> }
    const status = statusSchema.parse(await control.status())
    assert.equal(status.accounts[0].state, 'signed_out')
    assert.deepEqual(status.models.filter(model => model.provider === 'zcode-zai-start-plan').map(model => model.id), start)
    await fiber.dispose()
    assert.deepEqual(ctx.llm.listProviders(), [])
    assert.equal(ctx.get('zcode'), undefined)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
