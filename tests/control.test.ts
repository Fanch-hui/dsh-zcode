import test from 'node:test'
import assert from 'node:assert/strict'
import { createTypertRemoteInfo, type RemoteResult, type TypertCodec, type TypertClientRemote, type TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { ZCodeController, type RemoteFace } from '../src/client/controller.js'
import { keyInputSchema, remoteContribution, statusSchema } from '../src/control/remote.js'
import type { ZCodeStatus } from '../src/control/types.js'

const status = (state: 'signed_out' | 'authorizing' | 'ready'): ZCodeStatus => ({
  accounts: [{ platform: 'bigmodel', state, generation: 1 }, { platform: 'zai', state: 'signed_out', generation: 0 }],
  settings: { platform: 'bigmodel', concurrency: 2, maxTokens: 32000, timeoutMs: 300000, effort: 'high' },
  models: [], quotas: [],
})
const ok = (value: ZCodeStatus): RemoteResult<ZCodeStatus> => ({ ok: true, value })

test('remote boundary rejects secrets and unexpected fields in status', () => {
  const safe = status('ready')
  assert.equal(statusSchema.safeParse(safe).success, true)
  assert.equal(statusSchema.safeParse({ ...safe, token: 'fixture-secret' }).success, false)
  assert.equal(statusSchema.safeParse({ ...safe, accounts: [{ ...safe.accounts[0], token: 'fixture-secret' }] }).success, false)
  assert.equal(keyInputSchema.safeParse({ platform: 'bigmodel', key: 'fixture-secret', extra: true }).success, false)
  const start = { ...safe, accounts: [...safe.accounts, { platform: 'zai', plan: 'start-plan', state: 'ready', generation: 1 }],
    settings: { ...safe.settings, plan: 'start-plan' }, quotas: [{ platform: 'zai', plan: 'start-plan' }] }
  assert.equal(statusSchema.safeParse(start).success, true)
  assert.equal(statusSchema.safeParse({ ...start, accounts: [{ ...start.accounts[2], token: 'fixture-secret' }] }).success, false)
})

test('quota RPC accepts the existing one-argument call and forwards an optional plan', async () => {
  const descriptor = remoteContribution.descriptors.find(item => item.method === 'readQuota')!
  const strictCodec = (codec: TypertCodec): TypertRemoteCodecSpec => {
    assert.equal(codec.mode, 'strict')
    if (codec.mode !== 'strict') throw new Error('expected strict codec')
    return { ...codec, create: () => codec.create() as z.ZodType }
  }
  const info = createTypertRemoteInfo({ package: 'dsh-zcode', methods: { 'zcode/readQuota': {
    service: 'zcode', invocation: { kind: 'direct' },
    parameters: descriptor.parameters.map(parameter => ({ ...parameter, codec: strictCodec(parameter.codec), strictCodec: strictCodec(parameter.codec) })),
    result: strictCodec(descriptor.result),
  } } }, z)
  const method = info.methods['zcode/readQuota']
  const input = method.input().create()
  const seen: unknown[][] = []
  const remote = { zcode: { readQuota: async (...args: unknown[]) => { seen.push(args); return ok(status('ready')) } } } as unknown as TypertClientRemote
  await method.invoke(remote, input.parse({ platform: 'zai' }))
  await method.invoke(remote, input.parse({ platform: 'zai', plan: 'start-plan' }))
  assert.deepEqual(seen, [['zai', undefined], ['zai', 'start-plan']])
  assert.throws(() => input.parse({ platform: 'zai', plan: 'unknown' }))
})

test('a late status read cannot restore a cancelled login', async () => {
  let completeRead!: (value: RemoteResult<ZCodeStatus>) => void
  const read = new Promise<RemoteResult<ZCodeStatus>>(resolve => { completeRead = resolve })
  const remote: RemoteFace = {
    status: () => read,
    beginLogin: async () => ok(status('authorizing')),
    cancelLogin: async () => ok(status('signed_out')),
    disconnect: async () => ok(status('signed_out')),
    useApiKey: async () => ok(status('ready')),
    refreshModels: async () => ok(status('ready')),
    readQuota: async () => ok(status('ready')),
    refreshQuota: async () => ok(status('ready')),
  }
  const controller = new ZCodeController(remote)
  const pending = controller.refresh()
  await Promise.resolve()
  assert.equal(await controller.run('cancelLogin', 'bigmodel'), true)
  completeRead(ok(status('authorizing')))
  await pending
  assert.equal(controller.getSnapshot().status?.accounts[0].state, 'signed_out')
  controller.dispose()
})

test('login initialization can be cancelled before it returns', async () => {
  let completeLogin!: (value: RemoteResult<ZCodeStatus>) => void
  const login = new Promise<RemoteResult<ZCodeStatus>>(resolve => { completeLogin = resolve })
  let cancelled = 0
  const remote: RemoteFace = {
    status: async () => ok(status('signed_out')),
    beginLogin: () => login,
    cancelLogin: async () => { cancelled++; return ok(status('signed_out')) },
    disconnect: async () => ok(status('signed_out')),
    useApiKey: async () => ok(status('ready')),
    refreshModels: async () => ok(status('ready')),
    readQuota: async () => ok(status('ready')),
    refreshQuota: async () => ok(status('ready')),
  }
  const controller = new ZCodeController(remote)
  await controller.refresh()
  const pendingLogin = controller.run('beginLogin', 'bigmodel')
  assert.equal(controller.getSnapshot().pending, 'beginLogin')
  assert.equal(await controller.run('cancelLogin', 'zai'), false)
  assert.equal(await controller.run('cancelLogin', 'bigmodel'), true)
  assert.equal(cancelled, 1)
  assert.equal(controller.getSnapshot().pending, undefined)
  completeLogin(ok(status('authorizing')))
  assert.equal(await pendingLogin, false)
  assert.equal(controller.getSnapshot().status?.accounts[0].state, 'signed_out')
  assert.equal(controller.getSnapshot().pending, undefined)
  controller.dispose()
})

test('controller forwards the selected plan for quota and model actions', async () => {
  const calls: unknown[][] = []
  const remote: RemoteFace = {
    status: async () => ok(status('ready')),
    beginLogin: async () => ok(status('ready')),
    cancelLogin: async () => ok(status('ready')),
    disconnect: async () => ok(status('ready')),
    useApiKey: async () => ok(status('ready')),
    refreshModels: async (...args) => { calls.push(['refreshModels', ...args]); return ok(status('ready')) },
    readQuota: async (...args) => { calls.push(['readQuota', ...args]); return ok(status('ready')) },
    refreshQuota: async (...args) => { calls.push(['refreshQuota', ...args]); return ok(status('ready')) },
  }
  const controller = new ZCodeController(remote)
  try {
    await controller.run('refreshModels', 'zai', 'start-plan')
    await controller.run('readQuota', 'zai', 'start-plan')
    await controller.run('refreshQuota', 'zai')
    assert.deepEqual(calls, [
      ['refreshModels', 'zai', 'start-plan'],
      ['readQuota', 'zai', 'start-plan'],
      ['refreshQuota', 'zai', undefined],
    ])
  } finally { controller.dispose() }
})
