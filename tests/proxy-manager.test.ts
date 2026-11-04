import assert from 'node:assert/strict'
import test from 'node:test'
import { UpstreamManager } from '../src/proxy/manager.js'

const options = {
  deviceId: async () => '00000000-0000-4000-8000-000000000000',
  workerUrl: new URL('../lib/proxy/upstream.cjs', import.meta.url),
}

test('packaged proxy binds an authenticated loopback port and account invalidation stops it', async () => {
  const manager = new UpstreamManager(options)
  try {
    const engine = manager.get('zai', 'fixture:start-plan')
    const url = await engine.start('start-plan', { provider: 'zai', apiKey: 'fixture-upstream', jwt: 'fixture-jwt' })
    const endpoint = new URL(url)
    assert.equal(endpoint.hostname, '127.0.0.1')
    assert.equal(endpoint.pathname, '/v1/messages')
    const health = new URL('/health', endpoint)
    const unauthorized = await fetch(health)
    assert.equal(unauthorized.status, 401)
    await unauthorized.body?.cancel()
    const authorized = await fetch(health, { headers: { authorization: `Bearer ${engine.apiKey}` } })
    assert.deepEqual(await authorized.json(), { status: 'ok', provider: 'zai' })
    await assert.rejects(engine.start('coding-plan', { provider: 'zai', apiKey: 'fixture-upstream' }), /ZCODE_ACCOUNT_CHANGED/)
    assert.notEqual(manager.get('zai', 'fixture:coding-plan'), engine)
    manager.invalidate('zai')
    await assert.rejects(engine.rpc('quota'), /ZCODE_PROXY_STOPPED/)
    assert.notEqual(manager.get('zai', 'fixture:start-plan'), engine)
  } finally { manager.dispose() }
})

test('disposing during device preparation prevents a delayed process launch', async () => {
  let finish!: (value: string) => void
  const device = new Promise<string>(resolve => { finish = resolve })
  const manager = new UpstreamManager({ ...options, deviceId: () => device })
  const engine = manager.get('bigmodel')
  const waiting = engine.rpc('beginLogin')
  manager.dispose()
  finish('00000000-0000-4000-8000-000000000000')
  await assert.rejects(waiting, /ZCODE_DISPOSED/)
  assert.throws(() => manager.get('bigmodel'), /ZCODE_DISPOSED/)
})
