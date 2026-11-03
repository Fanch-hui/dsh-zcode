import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'
import { AuthError, ZcodeAuth, type CredentialStore, type StoredAccount } from '../src/auth/index.js'
import type { Platform } from '../src/types.js'

function store(initial: Partial<Record<Platform, StoredAccount>> = {}): CredentialStore & { records: Map<Platform, StoredAccount> } {
  const records = new Map(Object.entries(initial) as [Platform, StoredAccount][])
  const identity = (record?: StoredAccount): string | undefined => {
    const scope = record?.kind === 'grant' ? record.payload.scope : record?.env.DSH_ZCODE_SCOPE
    return scope ? `${record?.kind}:${scope}` : undefined
  }
  return {
    records,
    async load(platform) { return records.get(platform) },
    async save(platform, value, check, expected) {
      check()
      if (identity(records.get(platform)) !== identity(expected)) throw new AuthError('ZCODE_ACCOUNT_CHANGED')
      records.set(platform, value)
    },
    async remove(platform, check, expected) {
      check()
      if (identity(records.get(platform)) !== identity(expected)) throw new AuthError('ZCODE_ACCOUNT_CHANGED')
      records.delete(platform)
    },
  }
}

function response(data: unknown, status = 200): Response {
  return Response.json({ code: 0, data }, { status })
}

function grant(platform: Platform = 'bigmodel'): StoredAccount {
  return { kind: 'grant', payload: {
    schemaVersion: 1, platform, scope: 'synthetic-scope', oauthAccessToken: 'synthetic-oauth', zcodeToken: 'synthetic-zcode',
    location: { organizationId: 'org', projectId: 'project', apiKeyId: 'key-id' },
  } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await wait(5)
  }
  throw new Error('timed out waiting for test state')
}

test('manual account and quota are scoped and projected from recognized windows', async () => {
  let reads = 0
  const storage = store()
  const auth = new ZcodeAuth({ store: storage, now: () => 1_700_000_000_000, fetch: async (input, init) => {
    assert.equal(String(input), 'https://bigmodel.cn/api/monitor/usage/quota/limit')
    assert.equal(new Headers(init?.headers).get('authorization'), 'synthetic-key')
    assert.equal(init?.redirect, 'error')
    reads++
    return response({ limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, remaining: 60, usage: 100, nextResetTime: 1_700_000_500_000 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 25 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, remaining: 8 },
      { type: 'OTHER', unit: 3, number: 5, token: 'do-not-project' },
    ] })
  } })
  await auth.useApiKey('bigmodel', 'synthetic-key')
  const snapshot = await auth.snapshot('bigmodel')
  const [a, b] = await Promise.all([auth.queryQuota(snapshot), auth.queryQuota(snapshot)])
  assert.deepEqual(a, b)
  assert.equal(reads, 1)
  assert.deepEqual(a.windows, [
    { name: 'Token · 5 小时', usedPercent: 40, remaining: 60, limit: 100, resetsAt: 1_700_000_500_000 },
    { name: '积分 · 每周', usedPercent: 25 },
    { name: '工具调用', remaining: 8 },
  ])
  await auth.queryQuota(snapshot)
  assert.equal(reads, 1)
  await auth.queryQuota(snapshot, undefined, true)
  assert.equal(reads, 2)
  await auth.disconnect('bigmodel')
  await assert.rejects(auth.credential(snapshot), /ZCODE_ACCOUNT_CHANGED/)
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  assert.equal(storage.records.has('bigmodel'), false)
  auth.dispose()
})

test('concurrent PAT issuance survives one cancelled waiter and stale rejection', async () => {
  let now = 1_700_000_000_000
  let requests = 0
  const gate = deferred<Response>()
  const auth = new ZcodeAuth({ store: store({ bigmodel: grant() }), now: () => now, random: () => 0, fetch: async (_input, init) => {
    assert.equal(init?.redirect, 'error')
    requests++
    if (requests === 1) return gate.promise
    return response({ accessToken: 'synthetic-pat-2', tokenType: 'Bearer', expiresIn: 600, expiresAt: now / 1000 + 600 })
  } })
  const snapshot = await auth.snapshot('bigmodel')
  const controller = new AbortController()
  const first = auth.credential(snapshot, controller.signal)
  const second = auth.credential(snapshot)
  await until(() => requests === 1)
  controller.abort()
  await assert.rejects(first)
  gate.resolve(response({ accessToken: 'synthetic-pat-1', tokenType: 'Bearer', expiresIn: 600, expiresAt: now / 1000 + 600 }))
  const initial = await second
  assert.equal(initial.token, 'synthetic-pat-1')
  assert.equal(requests, 1)
  now += 481_000
  const replacement = await auth.credential(snapshot)
  assert.equal(replacement.token, 'synthetic-pat-2')
  assert.equal(requests, 2)
  auth.reject(snapshot, initial)
  assert.equal((await auth.credential(snapshot)).token, 'synthetic-pat-2')
  assert.equal(requests, 2)
  auth.dispose()
})

test('disconnect aborts the account and discards a late PAT response', async () => {
  const gate = deferred<Response>()
  let sent = false
  const storage = store({ bigmodel: grant() })
  const auth = new ZcodeAuth({ store: storage, now: () => 1_700_000_000_000, fetch: async () => { sent = true; return gate.promise } })
  const snapshot = await auth.snapshot('bigmodel')
  const pending = auth.credential(snapshot)
  await until(() => sent)
  await auth.disconnect('bigmodel')
  assert.equal(snapshot.signal.aborted, true)
  gate.resolve(response({ accessToken: 'synthetic-late', tokenType: 'Bearer', expiresIn: 600, expiresAt: 1_700_000_600 }))
  await assert.rejects(pending, /ZCODE_ACCOUNT_CHANGED/)
  assert.equal(storage.records.has('bigmodel'), false)
  auth.dispose()
})

test('polling login persists a grant, obtains the project PAT and exposes no credential in status', async () => {
  const now = 1_700_000_000_000
  const storage = store()
  let issueCount = 0
  const auth = new ZcodeAuth({ store: storage, now: () => now, random: () => 0, fetch: async (input, init) => {
    const url = String(input)
    assert.equal(init?.redirect, 'error')
    if (url.endsWith('/oauth/cli/init')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { provider: 'zai' })
      return response({ authorize_url: 'https://chat.z.ai/oauth/authorize?state=test', expires_at: now / 1000 + 60, flow_id: 'flow', poll_interval_sec: 1 })
    }
    if (url.endsWith('/oauth/cli/poll/flow')) return response({ status: 'ready', token: 'synthetic-zcode', user: { user_id: 'synthetic-user', name: 'Test' }, zai: { access_token: 'synthetic-oauth' } })
    if (url.endsWith('/api/auth/z/login')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { token: 'synthetic-oauth' })
      return response({ access_token: 'synthetic-business', expires_in: 600 })
    }
    if (url.endsWith('/api/biz/customer/getCustomerInfo')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'synthetic-business')
      return response({ organizations: [{ organizationId: 'org', projects: [{ projectId: 'project' }] }] })
    }
    if (url.endsWith('/api_keys')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-business')
      return response([{ apiKey: 'key-id', name: 'zcode-api-key' }])
    }
    assert.match(url, /\/api_keys\/key-id\/access_tokens$/)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-business')
    issueCount++
    return response({ accessToken: 'synthetic-pat', tokenType: 'Bearer', expiresIn: 600, expiresAt: now / 1000 + 600 })
  } })
  const started = await auth.beginLogin('zai')
  assert.equal(started.login?.authorizeUrl, 'https://chat.z.ai/oauth/authorize?state=test')
  await until(async () => (await auth.status('zai')).state === 'ready' && issueCount === 1)
  const status = await auth.status('zai')
  assert.equal(status.authMode, 'oauth')
  assert.equal(status.accountLabel, 'Test')
  assert.doesNotMatch(JSON.stringify(status), /synthetic-oauth|synthetic-pat|synthetic-zcode|synthetic-user/)
  assert.equal((await auth.credential(await auth.snapshot('zai'))).token, 'synthetic-pat')
  assert.equal(storage.records.get('zai')?.kind, 'grant')
  auth.dispose()
})

test('cancelled polling cannot overwrite a newly supplied account', async () => {
  const gate = deferred<Response>()
  const storage = store()
  const auth = new ZcodeAuth({ store: storage, now: () => 1_700_000_000_000, fetch: async input => {
    if (String(input).endsWith('/init')) return response({
      authorize_url: 'https://bigmodel.cn/login', expires_at: 1_700_000_060, flow_id: 'flow', poll_interval_sec: 1,
    })
    return gate.promise
  } })
  await auth.beginLogin('bigmodel')
  await auth.cancelLogin('bigmodel')
  await auth.useApiKey('bigmodel', 'synthetic-new-key')
  gate.resolve(response({ status: 'ready', token: 'synthetic-old-zcode', user: { user_id: 'old-user' }, bigmodel: { access_token: 'synthetic-old-oauth' } }))
  await wait(5)
  const status = await auth.status('bigmodel')
  assert.equal(status.authMode, 'api-key')
  assert.equal((await auth.credential(await auth.snapshot('bigmodel'))).token, 'synthetic-new-key')
  auth.dispose()
})

test('BigModel creates the dedicated project identity and repairs a missing identity on the next attempt', async () => {
  const now = 1_700_000_000_000
  const storage = store({ bigmodel: grant() })
  let issueCount = 0
  let created = 0
  const auth = new ZcodeAuth({ store: storage, now: () => now, random: () => 0, fetch: async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (url.endsWith('/api_keys/key-id/access_tokens')) {
      issueCount++
      return new Response(null, { status: 404 })
    }
    if (url.endsWith('/api/biz/customer/getCustomerInfo')) {
      assert.equal(headers.get('authorization'), 'synthetic-oauth')
      return response({ organizations: [
        { organizationId: 'other-org', projects: [{ projectId: 'other' }] },
        { organizationId: 'org2', organizationName: '默认机构', projects: [{ projectId: 'proj2', projectName: '默认项目' }] },
      ] })
    }
    if (url.endsWith('/api_keys') && init?.method === 'GET') {
      assert.equal(headers.get('authorization'), 'synthetic-oauth')
      return response([])
    }
    if (url.endsWith('/api_keys') && init?.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { name: 'zcode-api-key', usageScene: 1 })
      created++
      return response({ apiKey: 'replacement-id', name: 'zcode-api-key' })
    }
    assert.match(url, /org2\/projects\/proj2\/api_keys\/replacement-id\/access_tokens$/)
    assert.equal(headers.get('authorization'), 'Bearer synthetic-oauth')
    return response({ accessToken: 'synthetic-new-pat', tokenType: 'Bearer', expiresIn: 600, expiresAt: now / 1000 + 600 })
  } })
  const snapshot = await auth.snapshot('bigmodel')
  await assert.rejects(auth.credential(snapshot), /ZCODE_AUTH_HTTP_404/)
  const saved = storage.records.get('bigmodel')
  assert.equal(saved?.kind === 'grant' && saved.payload.location, undefined)
  assert.equal((await auth.credential(snapshot)).token, 'synthetic-new-pat')
  assert.equal(issueCount, 1)
  assert.equal(created, 1)
  const updated = storage.records.get('bigmodel')
  assert.deepEqual(updated?.kind === 'grant' && updated.payload.location, { organizationId: 'org2', projectId: 'proj2', apiKeyId: 'replacement-id' })
  auth.dispose()
})

test('temporary PAT renewal failures retain only an unexpired, unrejected PAT', async () => {
  let now = 1_700_000_000_000
  let attempts = 0
  const auth = new ZcodeAuth({ store: store({ bigmodel: grant() }), now: () => now, random: () => 0, fetch: async () => {
    attempts++
    if (attempts === 2) return new Response(null, { status: 503 })
    return response({ accessToken: `synthetic-pat-${attempts}`, tokenType: 'Bearer', expiresIn: 600, expiresAt: now / 1000 + 600 })
  } })
  const snapshot = await auth.snapshot('bigmodel')
  const first = await auth.credential(snapshot)
  now += 481_000
  const [second, third] = await Promise.all([auth.credential(snapshot), auth.credential(snapshot)])
  assert.equal(second.token, first.token)
  assert.equal(third.token, first.token)
  assert.equal(attempts, 2)
  now += 5_001
  assert.equal((await auth.credential(snapshot)).token, 'synthetic-pat-3')
  assert.equal(attempts, 3)
  auth.dispose()
})

test('manual keys reject non-ASCII before storage', async () => {
  const storage = store()
  const auth = new ZcodeAuth({ store: storage })
  await assert.rejects(auth.useApiKey('zai', 'synthetic-密钥'), /ZCODE_INVALID_API_KEY/)
  assert.equal(storage.records.size, 0)
  auth.dispose()
})

test('a fresh login changes replay scope for the same account and persists the new scope', async () => {
  const now = 1_700_000_000_000
  const storage = store()
  const auth = new ZcodeAuth({ store: storage, now: () => now, fetch: async input => {
    const url = String(input)
    if (url.endsWith('/init')) return response({ authorize_url: 'https://zcode.z.ai/login', expires_at: now / 1000 + 60, flow_id: 'flow', poll_interval_sec: 1 })
    if (url.endsWith('/poll/flow')) return response({ status: 'ready', token: 'synthetic-zcode', user: { user_id: 'same-user' }, bigmodel: { access_token: 'synthetic-oauth' } })
    return new Response(null, { status: 403 })
  } })
  await auth.beginLogin('bigmodel')
  await until(async () => (await auth.status('bigmodel')).generation === 1)
  const first = (await auth.status('bigmodel')).scope!
  await auth.beginLogin('bigmodel')
  await until(async () => (await auth.status('bigmodel')).generation === 2)
  const second = (await auth.status('bigmodel')).scope!
  assert.equal(first.split('.')[0], second.split('.')[0])
  assert.notEqual(first, second)
  auth.dispose()
  const restarted = new ZcodeAuth({ store: storage })
  assert.equal((await restarted.status('bigmodel')).scope, second)
  restarted.dispose()
})

test('quota state follows model windows and ignores a depleted tool window', async () => {
  let limits: unknown[] = [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 100, remaining: 0 }]
  const auth = new ZcodeAuth({ store: store(), fetch: async () => response({ limits }) })
  await auth.useApiKey('bigmodel', 'synthetic-key')
  const snapshot = await auth.snapshot('bigmodel')
  await auth.queryQuota(snapshot, undefined, true)
  assert.equal((await auth.status('bigmodel')).state, 'ready')
  limits = [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0 },
  ]
  await auth.queryQuota(snapshot, undefined, true)
  assert.equal((await auth.status('bigmodel')).state, 'quota_exhausted')
  limits = [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 }]
  await auth.queryQuota(await auth.snapshot('bigmodel'), undefined, true)
  assert.equal((await auth.status('bigmodel')).state, 'ready')
  auth.dispose()
})

test('cancelling during credential commit waits for the atomic write; disconnect leaves the account signed out', async () => {
  const now = 1_700_000_000_000
  const storage = store()
  const started = deferred<void>()
  const gate = deferred<void>()
  const originalSave = storage.save.bind(storage)
  storage.save = async (platform, record, check, expected) => {
    if (record.kind === 'grant') {
      check()
      started.resolve()
      await gate.promise
    }
    await originalSave(platform, record, check, expected)
  }
  const auth = new ZcodeAuth({ store: storage, now: () => now, fetch: async input => {
    const url = String(input)
    if (url.endsWith('/init')) return response({ authorize_url: 'https://bigmodel.cn/login', expires_at: now / 1000 + 60, flow_id: 'flow', poll_interval_sec: 1 })
    if (url.endsWith('/poll/flow')) return response({ status: 'ready', token: 'synthetic-zcode', user: { user_id: 'same-user' }, bigmodel: { access_token: 'synthetic-oauth' } })
    return new Response(null, { status: 403 })
  } })
  await auth.beginLogin('bigmodel')
  await started.promise
  let cancelled = false
  const cancellation = auth.cancelLogin('bigmodel').then(() => { cancelled = true })
  await wait(5)
  assert.equal(cancelled, false)
  gate.resolve()
  await cancellation
  assert.equal((await auth.status('bigmodel')).state, 'ready')
  await auth.disconnect('bigmodel')
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  assert.equal(storage.records.size, 0)
  auth.dispose()
})

test('OAuth accepts official origins and rejects an unknown authorization host', async () => {
  const now = 1_700_000_000_000
  const auth = new ZcodeAuth({ store: store(), now: () => now, fetch: async () => response({
    authorize_url: 'https://example.invalid/authorize', expires_at: now / 1000 + 60, flow_id: 'flow', poll_interval_sec: 1,
  }) })
  await assert.rejects(auth.beginLogin('bigmodel'), /ZCODE_OAUTH_INVALID_URL/)
  auth.dispose()
})

test('an invalid stored account can be replaced or disconnected', async () => {
  const storage = store({ bigmodel: { kind: 'grant', payload: { schemaVersion: 4 } } as unknown as StoredAccount })
  const auth = new ZcodeAuth({ store: storage })
  const invalid = await auth.status('bigmodel')
  assert.equal(invalid.state, 'error')
  assert.equal(invalid.errorCode, 'ZCODE_CREDENTIAL_INVALID')
  await auth.useApiKey('bigmodel', 'synthetic-key')
  assert.equal((await auth.status('bigmodel')).state, 'ready')
  await auth.disconnect('bigmodel')
  assert.equal(storage.records.size, 0)
  auth.dispose()
})

test('another Host switching or disconnecting a shared account invalidates the original snapshot', async () => {
  const storage = store()
  const first = new ZcodeAuth({ store: storage })
  const second = new ZcodeAuth({ store: storage })
  await first.useApiKey('bigmodel', 'synthetic-key-one')
  const original = await first.snapshot('bigmodel')
  await second.snapshot('bigmodel')
  await second.useApiKey('bigmodel', 'synthetic-key-two')
  await assert.rejects(first.credential(original), /ZCODE_ACCOUNT_CHANGED/)
  assert.equal(original.signal.aborted, true)
  const updated = await first.snapshot('bigmodel')
  assert.notEqual(updated.scope, original.scope)
  assert.equal((await first.credential(updated)).token, 'synthetic-key-two')
  await second.disconnect('bigmodel')
  await assert.rejects(first.credential(updated), /ZCODE_ACCOUNT_CHANGED/)
  assert.equal((await first.status('bigmodel')).state, 'signed_out')
  first.dispose()
  second.dispose()
})

test('a late project location update cannot overwrite a shared account switched by another Host', async () => {
  const oldGrant = grant() as Extract<StoredAccount, { kind: 'grant' }>
  delete oldGrant.payload.location
  const storage = store({ bigmodel: oldGrant })
  const customer = deferred<Response>()
  let customerRequested = false
  const first = new ZcodeAuth({ store: storage, fetch: async input => {
    if (String(input).endsWith('/getCustomerInfo')) { customerRequested = true; return customer.promise }
    if (String(input).endsWith('/api_keys')) return response([{ apiKey: 'synthetic-id', name: 'zcode-api-key' }])
    throw new Error('unexpected request')
  } })
  const second = new ZcodeAuth({ store: storage })
  const original = await first.snapshot('bigmodel')
  const pending = first.credential(original)
  await until(() => customerRequested)
  await second.useApiKey('bigmodel', 'synthetic-new-key')
  customer.resolve(response({ organizations: [{ organizationId: 'org', projects: [{ projectId: 'project' }] }] }))
  await assert.rejects(pending, /ZCODE_ACCOUNT_CHANGED/)
  const current = storage.records.get('bigmodel')
  assert.equal(current?.kind, 'api-key')
  assert.equal(current?.kind === 'api-key' && current.key, 'synthetic-new-key')
  assert.equal((await first.credential(await first.snapshot('bigmodel'))).token, 'synthetic-new-key')
  first.dispose()
  second.dispose()
})

test('cancelling while OAuth initialization is in flight aborts the request and keeps the account signed out', async () => {
  const started = deferred<void>()
  const auth = new ZcodeAuth({ store: store(), fetch: async (_input, init) => {
    started.resolve()
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  } })
  const pending = auth.beginLogin('bigmodel')
  await started.promise
  await auth.cancelLogin('bigmodel')
  await assert.rejects(pending)
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  auth.dispose()
})

test('disconnect immediately aborts the account while storage removal is pending', async () => {
  const storage = store()
  const started = deferred<void>()
  const gate = deferred<void>()
  const remove = storage.remove.bind(storage)
  storage.remove = async (platform, check, expected) => {
    started.resolve()
    await gate.promise
    await remove(platform, check, expected)
  }
  const auth = new ZcodeAuth({ store: storage })
  await auth.useApiKey('bigmodel', 'synthetic-key')
  const snapshot = await auth.snapshot('bigmodel')
  const pending = auth.disconnect('bigmodel')
  await started.promise
  assert.equal(snapshot.signal.aborted, true)
  assert.equal((snapshot.signal.reason as Error).message, 'ZCODE_ACCOUNT_CHANGED')
  gate.resolve()
  await pending
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  auth.dispose()
})

test('a failed disconnect blocks the old account until a successful retry', async () => {
  const storage = store()
  const remove = storage.remove.bind(storage)
  let attempts = 0
  storage.remove = async (platform, check, expected) => {
    if (++attempts === 1) throw new Error('synthetic storage failure')
    await remove(platform, check, expected)
  }
  const auth = new ZcodeAuth({ store: storage })
  await auth.useApiKey('bigmodel', 'synthetic-key')
  const old = await auth.snapshot('bigmodel')
  await assert.rejects(auth.disconnect('bigmodel'), /ZCODE_DISCONNECT_FAILED/)
  assert.equal(old.signal.aborted, true)
  assert.equal((await auth.status('bigmodel')).errorCode, 'ZCODE_DISCONNECT_FAILED')
  await assert.rejects(auth.snapshot('bigmodel'), /ZCODE_LOGIN_REQUIRED/)
  await auth.disconnect('bigmodel')
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  auth.dispose()
})

test('disconnect from a stale Host preserves the new account owned by another Host', async () => {
  const storage = store()
  const first = new ZcodeAuth({ store: storage })
  const second = new ZcodeAuth({ store: storage })
  await first.useApiKey('bigmodel', 'synthetic-old-key')
  await second.snapshot('bigmodel')
  await second.useApiKey('bigmodel', 'synthetic-new-key')
  await assert.rejects(first.disconnect('bigmodel'), /ZCODE_ACCOUNT_CHANGED/)
  const snapshot = await first.snapshot('bigmodel')
  assert.equal((await first.credential(snapshot)).token, 'synthetic-new-key')
  first.dispose()
  second.dispose()
})

test('an authorization signal cancels its own pending init', async () => {
  const started = deferred<void>()
  const auth = new ZcodeAuth({ store: store(), fetch: async (_input, init) => {
    started.resolve()
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  } })
  const controller = new AbortController()
  const pending = auth.beginLogin('bigmodel', controller.signal)
  await started.promise
  controller.abort()
  await assert.rejects(pending)
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  auth.dispose()
})

test('an old authorization signal cannot cancel a newer polling attempt', async () => {
  const now = 1_700_000_000_000
  let attempts = 0
  const auth = new ZcodeAuth({ store: store(), now: () => now, fetch: async (input, init) => {
    if (String(input).endsWith('/init')) return response({
      authorize_url: 'https://bigmodel.cn/login', expires_at: now / 1000 + 60, flow_id: `flow-${++attempts}`, poll_interval_sec: 1,
    })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  } })
  const first = new AbortController()
  const second = new AbortController()
  const old = await auth.beginLogin('bigmodel', first.signal)
  const current = await auth.beginLogin('bigmodel', second.signal)
  assert.notEqual(old.login?.attemptId, current.login?.attemptId)
  first.abort()
  assert.equal((await auth.status('bigmodel')).login?.attemptId, current.login?.attemptId)
  second.abort()
  assert.equal((await auth.status('bigmodel')).state, 'signed_out')
  auth.dispose()
})

test('a late quota response cannot be committed after another Host changes accounts', async () => {
  const storage = store()
  const gate = deferred<Response>()
  const sent = deferred<void>()
  const first = new ZcodeAuth({ store: storage, fetch: async () => { sent.resolve(); return gate.promise } })
  const second = new ZcodeAuth({ store: storage })
  await first.useApiKey('bigmodel', 'synthetic-old-key')
  const old = await first.snapshot('bigmodel')
  const pending = first.queryQuota(old)
  await sent.promise
  await second.useApiKey('bigmodel', 'synthetic-new-key')
  gate.resolve(response({ limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] }))
  await assert.rejects(pending, /ZCODE_ACCOUNT_CHANGED/)
  assert.equal(old.signal.aborted, true)
  assert.equal((await first.status('bigmodel')).state, 'ready')
  first.dispose()
  second.dispose()
})

test('the completion waiter distinguishes a superseded attempt from a later successful login', async () => {
  const now = 1_700_000_000_000
  let attempts = 0
  const auth = new ZcodeAuth({ store: store(), now: () => now, fetch: async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) return response({
      authorize_url: 'https://bigmodel.cn/login', expires_at: now / 1000 + 60, flow_id: `flow-${++attempts}`, poll_interval_sec: 1,
    })
    if (url.endsWith('/poll/flow-1')) return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    if (url.endsWith('/poll/flow-2')) return response({ status: 'ready', token: 'synthetic-zcode', user: { user_id: 'new-user' }, bigmodel: { access_token: 'synthetic-oauth' } })
    return new Response(null, { status: 403 })
  } })
  const first = await auth.beginLogin('bigmodel')
  const oldResult = auth.waitForLogin('bigmodel', first.login!.attemptId)
  const oldFailure = assert.rejects(oldResult, /ZCODE_OAUTH_CANCELLED/)
  const second = await auth.beginLogin('bigmodel')
  await oldFailure
  await auth.waitForLogin('bigmodel', second.login!.attemptId)
  assert.equal((await auth.status('bigmodel')).state, 'ready')
  await assert.rejects(auth.waitForLogin('bigmodel', first.login!.attemptId), /ZCODE_OAUTH_CANCELLED/)
  auth.dispose()
})

test('cancellation during a credential commit waits for that attempt to settle', async () => {
  const now = 1_700_000_000_000
  const storage = store()
  const startedCommit = deferred<void>()
  const gate = deferred<void>()
  const save = storage.save.bind(storage)
  storage.save = async (platform, record, check, expected) => {
    if (record.kind === 'grant') { startedCommit.resolve(); await gate.promise }
    await save(platform, record, check, expected)
  }
  const auth = new ZcodeAuth({ store: storage, now: () => now, fetch: async input => {
    const url = String(input)
    if (url.endsWith('/init')) return response({ authorize_url: 'https://bigmodel.cn/login', expires_at: now / 1000 + 60, flow_id: 'flow', poll_interval_sec: 1 })
    if (url.endsWith('/poll/flow')) return response({ status: 'ready', token: 'synthetic-zcode', user: { user_id: 'same-user' }, bigmodel: { access_token: 'synthetic-oauth' } })
    return new Response(null, { status: 403 })
  } })
  const controller = new AbortController()
  const started = await auth.beginLogin('bigmodel', controller.signal)
  const completion = auth.waitForLogin('bigmodel', started.login!.attemptId, controller.signal)
  await startedCommit.promise
  let settled = false
  void completion.then(() => { settled = true }, () => { settled = true })
  controller.abort()
  await wait(5)
  assert.equal(settled, false)
  gate.resolve()
  await completion
  assert.equal(storage.records.get('bigmodel')?.kind, 'grant')
  auth.dispose()
})
