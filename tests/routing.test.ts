import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountSnapshot, RequestCredential } from '../src/types.js'
import { EndpointRouter } from '../src/transport/routing.js'

const directUrl = 'https://api.z.ai/api/anthropic/v1/messages'
const gatewayUrl = 'https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages'

function account(scope = 'fixture-account', controller = new AbortController()): AccountSnapshot {
  return { platform: 'zai', scope, generation: 1, mode: 'oauth', signal: controller.signal }
}

function credential(id = 'fixture-id', identity = 'fixture-zcode-jwt'): RequestCredential {
  return { kind: 'pat', revision: 1, token: 'fixture-pat', routing: { apiKeyId: id, zcodeToken: identity } }
}

function config(mapping?: unknown): Response {
  return Response.json({ code: 0, data: mapping === undefined ? {} : { proxyEndpoint: { mapping } } })
}

const routed = [{ from: directUrl, to: gatewayUrl, zcodeAuthorizationHeader: 'X-Zcode-Authorization' }]

test('uses direct endpoints for manual keys and requests OAuth routes without model credentials', async () => {
  let calls = 0
  const router = new EndpointRouter({ fetch: async (url, init) => {
    calls++
    assert.equal(String(url), 'https://zcode.z.ai/api/v1/agent/configs')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.body, undefined)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('accept'), 'application/json')
    assert.equal(headers.get('x-api-key-id'), 'fixture-id')
    assert.equal(headers.get('x-api-key'), null)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('cookie'), null)
    return config([])
  } })
  const active = account()
  try {
    const manual = { ...active, mode: 'api-key' as const }
    assert.deepEqual(await router.resolve(manual, { token: 'fixture-key', kind: 'api-key', revision: 1 }), { url: directUrl })
    assert.equal(calls, 0)
    assert.deepEqual(await router.resolve(active, credential()), { url: directUrl })
    assert.equal(calls, 1)
    assert.deepEqual(await router.resolve(active, credential()), { url: directUrl })
    assert.equal(calls, 1)
  } finally { router.dispose() }
})

test('routes normalized exact endpoint matches and attaches only the authorized gateway identity', async () => {
  let calls = 0
  const router = new EndpointRouter({ fetch: async () => {
    calls++
    return config([{ from: 'https://API.Z.AI:443/api/anthropic/v1/messages/', to: gatewayUrl,
      zcodeAuthorizationHeader: 'x-zcode-authorization' }])
  } })
  const active = account()
  try {
    assert.deepEqual(await router.resolve(active, credential()), {
      url: gatewayUrl, headers: { 'X-ZCode-Authorization': 'Bearer fixture-zcode-jwt' },
    })
    assert.deepEqual(await router.resolve(active, credential('fixture-id', 'Bearer fixture-other-jwt')), {
      url: gatewayUrl, headers: { 'X-ZCode-Authorization': 'Bearer fixture-other-jwt' },
    })
    await assert.rejects(router.resolve(active, credential('fixture-id', '  ')), (error: unknown) =>
      error instanceof LlmError && error.code === 'AUTH')
    assert.equal(calls, 1)
  } finally { router.dispose() }
})

test('refreshes routing for a new PAT revision without mixing owners in concurrent attempts', async () => {
  const ids: string[] = []
  const router = new EndpointRouter({ fetch: async (_url, init) => {
    const key = new Headers(init?.headers).get('x-api-key-id') ?? ''
    ids.push(key)
    return config(key === 'fixture-owner-1' ? routed : [])
  } })
  const active = account()
  const first = credential('fixture-owner-1')
  const second = { ...credential('fixture-owner-2'), revision: 2 }
  try {
    assert.equal((await router.resolve(active, first)).url, gatewayUrl)
    assert.equal((await router.resolve(active, second)).url, directUrl)
    assert.equal((await router.resolve(active, first)).url, gatewayUrl)
    assert.deepEqual(ids, ['fixture-owner-1', 'fixture-owner-2'])
  } finally { router.dispose() }
})

test('rejects unsafe or invalid mappings as a complete snapshot', async t => {
  const invalid = [
    [{ from: directUrl, to: 'https://elsewhere.example/collect' }],
    [{ from: directUrl, to: 'http://api.z.ai/api/anthropic/v1/messages' }],
    [{ from: directUrl, to: 'https://api.z.ai/api/anthropic/v1/messages?fixture=1' }],
    [{ from: directUrl, to: 'https://user:fixture@api.z.ai/api/anthropic/v1/messages' }],
    [{ from: directUrl, to: gatewayUrl, zcodeAuthorizationHeader: 'Authorization' }],
    [{ from: directUrl, to: 'https://api.z.ai/api/anthropic/v1/messages', zcodeAuthorizationHeader: 'X-ZCode-Authorization' }],
    [{ from: directUrl, to: 'https://zcode.z.ai/api/v1/ultra-zai-other/messages', zcodeAuthorizationHeader: 'X-ZCode-Authorization' }],
    [{ from: directUrl, to: gatewayUrl }, { from: `${directUrl}/`, to: gatewayUrl }],
    Array.from({ length: 257 }, (_, index) => ({ from: `https://api.z.ai/${index}`, to: gatewayUrl })),
    'not-an-array',
  ]
  for (const [index, mapping] of invalid.entries()) await t.test(String(index), async () => {
    const warnings: string[] = []
    const router = new EndpointRouter({ fetch: async () => config(mapping), onWarning: reason => warnings.push(reason) })
    try {
      assert.deepEqual(await router.resolve(account(), credential()), { url: directUrl })
      assert.deepEqual(warnings, ['invalid_response'])
    } finally { router.dispose() }
  })
})

test('keeps the last valid mapping after refresh failure, and refreshes after cooldown', async () => {
  let now = 1_000
  let calls = 0
  const warnings: string[] = []
  const router = new EndpointRouter({
    now: () => now,
    onWarning: reason => warnings.push(reason),
    fetch: async () => {
      calls++
      if (calls === 1) return config(routed)
      if (calls === 2) return new Response('fixture-response', { status: 503 })
      return config([])
    },
  })
  const active = account()
  try {
    assert.equal((await router.resolve(active, credential())).url, gatewayUrl)
    now += 300_001
    assert.equal((await router.resolve(active, credential())).url, gatewayUrl)
    assert.deepEqual(warnings, ['upstream_error'])
    now += 29_999
    assert.equal((await router.resolve(active, credential())).url, gatewayUrl)
    assert.equal(calls, 2)
    now += 2
    assert.deepEqual(await router.resolve(active, credential()), { url: directUrl })
    assert.equal(calls, 3)
  } finally { router.dispose() }
})

test('shares a route refresh without allowing one cancelled request to stop another', async () => {
  let calls = 0
  let complete: ((value: Response) => void) | undefined
  let fetchSignal: AbortSignal | null | undefined
  const router = new EndpointRouter({ fetch: async (_url, init) => {
    calls++
    fetchSignal = init?.signal
    return new Promise<Response>(resolve => { complete = resolve })
  } })
  const active = account()
  const cancelled = new AbortController()
  try {
    const first = router.resolve(active, credential(), cancelled.signal)
    const second = router.resolve(active, credential())
    cancelled.abort(new Error('fixture cancellation'))
    await assert.rejects(first, /fixture cancellation/)
    assert.equal(fetchSignal?.aborted, false)
    assert.equal(calls, 1)
    assert.ok(complete)
    complete(config(routed))
    assert.equal((await second).url, gatewayUrl)
  } finally { router.dispose() }
})

test('isolates account caches and cancels outstanding refreshes when the account ends', async () => {
  const calls: string[] = []
  let pendingSignal: AbortSignal | null | undefined
  const router = new EndpointRouter({ fetch: async (_url, init) => {
    const key = new Headers(init?.headers).get('x-api-key-id') ?? 'none'
    calls.push(key)
    if (key === 'fixture-pending') {
      pendingSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        pendingSignal?.addEventListener('abort', () => reject(pendingSignal?.reason), { once: true })
      })
    }
    return config(key === 'fixture-first' ? routed : [])
  } })
  const first = account('first')
  const second = account('second')
  const controller = new AbortController()
  try {
    assert.equal((await router.resolve(first, credential('fixture-first'))).url, gatewayUrl)
    assert.equal((await router.resolve(second, credential('fixture-second'))).url, directUrl)
    assert.equal((await router.resolve(first, credential('fixture-first'))).url, gatewayUrl)
    const pending = router.resolve(account('third', controller), credential('fixture-pending'))
    controller.abort(new Error('fixture account changed'))
    await assert.rejects(pending, /fixture account changed/)
    assert.equal(pendingSignal?.aborted, true)
    assert.deepEqual(calls, ['fixture-first', 'fixture-second', 'fixture-pending'])
  } finally { router.dispose() }
})

test('omits invalid owner identifiers and bounds control-plane response bodies', async () => {
  let cancelled = false
  const warnings: string[] = []
  const router = new EndpointRouter({
    onWarning: reason => warnings.push(reason),
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('x-api-key-id'), null)
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(262_145)) },
        cancel() { cancelled = true },
      }))
    },
  })
  try {
    assert.deepEqual(await router.resolve(account(), credential('fixture-\ninvalid')), { url: directUrl })
    assert.deepEqual(warnings, ['invalid_response'])
    assert.equal(cancelled, true)
  } finally { router.dispose() }
})
