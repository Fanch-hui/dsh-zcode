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
    ctx.provide('profileContext', { dir: '/synthetic/profile' })
    ctx.provide('attachments', { readImage: async () => { throw new Error('no image requested') } })
    ctx.typert.register(TYPERT)
    const fiber = await ctx.plugin(plugin, {})
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id).sort(), ['zcode-bigmodel', 'zcode-zai'])
    assert.equal((await ctx.llm.listModels('zcode-bigmodel')).length, 2)
    const control = ctx.get('zcode') as { status(): Promise<unknown> }
    assert.equal(statusSchema.parse(await control.status()).accounts[0].state, 'signed_out')
    await fiber.dispose()
    assert.deepEqual(ctx.llm.listProviders(), [])
    assert.equal(ctx.get('zcode'), undefined)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
