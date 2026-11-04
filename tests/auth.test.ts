import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthError, ZcodeAuth, type CredentialStore, type StoredAccount } from '../src/auth/index.js'
import type { Platform } from '../src/types.js'
import { deferred, FixtureUpstream } from './helpers/upstream.js'

function store(initial: Partial<Record<Platform, StoredAccount>> = {}) {
  const records = new Map(Object.entries(initial) as [Platform, StoredAccount][])
  const identity = (record?: StoredAccount) => record?.kind === 'grant'
    ? `grant:${record.payload.scope}` : record?.kind === 'api-key' ? `api-key:${record.env.DSH_ZCODE_SCOPE}` : undefined
  const storage: CredentialStore & { records: Map<Platform, StoredAccount> } = {
    records,
    async load(platform) { return records.get(platform) },
    async save(platform, record, check, expected) {
      check()
      if (identity(records.get(platform)) !== identity(expected)) throw new AuthError('ZCODE_ACCOUNT_CHANGED')
      records.set(platform, structuredClone(record))
    },
    async remove(platform, check, expected) {
      check()
      if (identity(records.get(platform)) !== identity(expected)) throw new AuthError('ZCODE_ACCOUNT_CHANGED')
      records.delete(platform)
    },
  }
  return storage
}

const legacy: StoredAccount = { kind: 'grant', payload: {
  schemaVersion: 1, platform: 'zai', scope: 'fixture-old-scope',
  oauthAccessToken: 'fixture-oauth', zcodeToken: 'fixture-jwt',
} }

test('login stores the upstream credential privately and uses the account-scoped proxy', async () => {
  const storage = store()
  const upstream = new FixtureUpstream()
  const auth = new ZcodeAuth({ store: storage, upstream })
  try {
    const status = await auth.beginLogin('zai')
    assert.equal(status.state, 'authorizing')
    assert.ok(status.login)
    await auth.waitForLogin('zai', status.login.attemptId)
    const current = await auth.status('zai')
    assert.equal(current.state, 'ready')
    assert.equal(current.authMode, 'oauth')
    assert.equal(JSON.stringify(current).includes('fixture-secret'), false)
    const record = storage.records.get('zai')
    assert.equal(record?.kind, 'grant')
    if (record?.kind !== 'grant') throw new Error('missing grant')
    assert.equal(record.payload.upstream?.secret, 'fixture-secret')
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    const credential = await auth.credential(snapshot)
    assert.deepEqual(credential, { kind: 'proxy', token: 'fixture-local-key', url: 'http://127.0.0.1:22334/v1/messages', revision: snapshot.generation })
    const call = upstream.calls.find(item => item.method === 'start')
    assert.equal(call?.scope, `${snapshot.scope}:start-plan`)
    assert.equal((call?.params as { plan: string }).plan, 'start-plan')
  } finally { auth.dispose() }
})

test('cancelled login cannot replace the selected account when its result arrives late', async () => {
  const completion = deferred<unknown>()
  const started = deferred<void>()
  const upstream = new FixtureUpstream(method => {
    if (method === 'completeLogin') { started.resolve(); return completion.promise }
  })
  const storage = store()
  const auth = new ZcodeAuth({ store: storage, upstream })
  try {
    await auth.useApiKey('zai', 'fixture-existing')
    const login = await auth.beginLogin('zai')
    await started.promise
    await auth.cancelLogin('zai')
    completion.resolve({ provider: 'zai', apiKey: 'fixture-late', jwt: 'fixture-jwt' })
    await assert.rejects(auth.waitForLogin('zai', login.login!.attemptId), /ZCODE_OAUTH_CANCELLED/)
    assert.equal((await auth.status('zai')).authMode, 'api-key')
    assert.equal((storage.records.get('zai') as Extract<StoredAccount, { kind: 'api-key' }>).key, 'fixture-existing')
  } finally { auth.dispose() }
})

test('legacy grants migrate once through the upstream resolver and one waiter can cancel', async () => {
  const resolution = deferred<unknown>()
  const entered = deferred<void>()
  const upstream = new FixtureUpstream(method => {
    if (method === 'resolve') { entered.resolve(); return resolution.promise }
  })
  const storage = store({ zai: legacy })
  const auth = new ZcodeAuth({ store: storage, upstream })
  try {
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    const cancelled = new AbortController()
    const first = auth.credential(snapshot, cancelled.signal)
    const second = auth.credential(snapshot)
    await entered.promise
    cancelled.abort()
    await assert.rejects(first)
    resolution.resolve({ provider: 'zai', apiKey: 'fixture-resolved', secret: 'fixture-secret', jwt: 'fixture-jwt' })
    assert.equal((await second).kind, 'proxy')
    assert.equal(upstream.calls.filter(call => call.method === 'resolve').length, 1)
    const migrated = storage.records.get('zai')
    assert.equal(migrated?.kind, 'grant')
    if (migrated?.kind !== 'grant') throw new Error('missing grant')
    assert.equal(migrated.payload.upstream?.apiKey, 'fixture-resolved')
  } finally { auth.dispose() }
})

test('a late migration cannot overwrite an account selected by another host', async () => {
  const resolution = deferred<unknown>()
  const entered = deferred<void>()
  const upstream = new FixtureUpstream(method => {
    if (method === 'resolve') { entered.resolve(); return resolution.promise }
  })
  const storage = store({ zai: legacy })
  const first = new ZcodeAuth({ store: storage, upstream })
  const second = new ZcodeAuth({ store: storage, upstream: new FixtureUpstream() })
  try {
    const snapshot = await first.snapshot('zai')
    const pending = first.credential(snapshot)
    await entered.promise
    await second.useApiKey('zai', 'fixture-new-key')
    resolution.resolve({ provider: 'zai', apiKey: 'fixture-resolved', jwt: 'fixture-jwt' })
    await assert.rejects(pending, /ZCODE_ACCOUNT_CHANGED/)
    assert.equal((await first.status('zai')).authMode, 'api-key')
    const saved = storage.records.get('zai')
    assert.equal(saved?.kind === 'api-key' && saved.key, 'fixture-new-key')
  } finally { first.dispose(); second.dispose() }
})

test('manual credentials never use Start Plan and are passed to the proxy as upstream credentials', async () => {
  const upstream = new FixtureUpstream()
  const auth = new ZcodeAuth({ store: store(), upstream })
  try {
    await auth.useApiKey('zai', 'fixture-id.fixture-secret')
    await assert.rejects(auth.snapshot('zai', undefined, 'start-plan'), /ZCODE_START_LOGIN_REQUIRED/)
    const request = await auth.credential(await auth.snapshot('zai'))
    assert.equal(request.token, 'fixture-local-key')
    const call = upstream.calls.find(item => item.method === 'start')
    assert.deepEqual((call?.params as { credential: unknown }).credential,
      { provider: 'zai', apiKey: 'fixture-id', secret: 'fixture-secret' })
  } finally { auth.dispose() }
})

test('superseding login initialization releases its worker and preserves the newer attempt', async () => {
  const late = deferred<unknown>()
  const entered = deferred<void>()
  let starts = 0
  const upstream = new FixtureUpstream(method => {
    if (method === 'beginLogin' && ++starts === 1) { entered.resolve(); return late.promise }
  })
  const storage = store()
  const auth = new ZcodeAuth({ store: storage, upstream })
  try {
    const first = auth.beginLogin('zai')
    await entered.promise
    const second = await auth.beginLogin('zai')
    await assert.rejects(first)
    late.resolve({ attemptId: 'fixture-old', authorizeUrl: 'https://chat.z.ai/old', expiresAt: Date.now() + 30_000 })
    await auth.waitForLogin('zai', second.login!.attemptId)
    assert.equal((await auth.status('zai')).state, 'ready')
    const startsCalled = upstream.calls.filter(call => call.method === 'beginLogin')
    assert.notEqual(startsCalled[0].scope, startsCalled[1].scope)
    assert.equal(storage.records.get('zai')?.kind, 'grant')
  } finally { auth.dispose() }
})

test('login URL validation rejects an unrelated destination', async () => {
  const upstream = new FixtureUpstream(method => method === 'beginLogin'
    ? { attemptId: 'fixture', authorizeUrl: 'https://example.invalid/authorize', expiresAt: Date.now() + 30_000 } : undefined)
  const auth = new ZcodeAuth({ store: store(), upstream })
  try {
    await assert.rejects(auth.beginLogin('zai'), /ZCODE_OAUTH_INVALID_URL/)
    assert.equal(upstream.calls.some(call => call.method === 'completeLogin'), false)
  } finally { auth.dispose() }
})

test('cancellation waits for an in-flight credential commit', async () => {
  const storage = store()
  const entered = deferred<void>()
  const release = deferred<void>()
  const save = storage.save.bind(storage)
  storage.save = async (platform, record, check, expected) => {
    if (record.kind === 'grant') { check(); entered.resolve(); await release.promise }
    await save(platform, record, check, expected)
  }
  const auth = new ZcodeAuth({ store: storage, upstream: new FixtureUpstream() })
  try {
    const login = await auth.beginLogin('zai')
    await entered.promise
    let settled = false
    const cancellation = auth.cancelLogin('zai').then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    release.resolve()
    await cancellation
    await auth.waitForLogin('zai', login.login!.attemptId)
    assert.equal((await auth.status('zai')).state, 'ready')
  } finally { release.resolve(); auth.dispose() }
})

test('failed disconnect revokes the current snapshot and a retry clears the account', async () => {
  const storage = store()
  const remove = storage.remove.bind(storage)
  let attempts = 0
  storage.remove = async (platform, check, expected) => {
    if (++attempts === 1) throw new Error('fixture storage failure')
    await remove(platform, check, expected)
  }
  const auth = new ZcodeAuth({ store: storage, upstream: new FixtureUpstream() })
  try {
    await auth.useApiKey('zai', 'fixture-key')
    const snapshot = await auth.snapshot('zai')
    await assert.rejects(auth.disconnect('zai'), /ZCODE_DISCONNECT_FAILED/)
    assert.equal(snapshot.signal.aborted, true)
    await assert.rejects(auth.snapshot('zai'), /ZCODE_LOGIN_REQUIRED/)
    await auth.disconnect('zai')
    assert.equal((await auth.status('zai')).state, 'signed_out')
  } finally { auth.dispose() }
})
