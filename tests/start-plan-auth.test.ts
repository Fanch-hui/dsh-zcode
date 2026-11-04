import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { AuthError, ZcodeAuth, type CredentialStore, type StoredAccount } from '../src/auth/index.js'
import type { Platform } from '../src/types.js'

function grant(scope = 'fixture-scope', token = 'fixture-zcode'): StoredAccount {
  return { kind: 'grant', payload: {
    schemaVersion: 1, platform: 'zai', scope, oauthAccessToken: 'fixture-oauth', zcodeToken: token,
    location: { organizationId: 'fixture-org', projectId: 'fixture-project', apiKeyId: 'fixture-key-id' },
  } }
}

function store(initial?: StoredAccount): CredentialStore & { records: Map<Platform, StoredAccount> } {
  const records = new Map<Platform, StoredAccount>(initial ? [['zai', initial]] : [])
  return {
    records,
    async load(platform) { return records.get(platform) },
    async save(platform, value, check) { check(); records.set(platform, value) },
    async remove(platform, check) { check(); records.delete(platform) },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await wait(5)
  }
  throw new Error('timed out waiting for fixture')
}

test('Start Plan reuses the current login without requesting a Coding Plan PAT', async () => {
  const auth = new ZcodeAuth({ store: store(grant()), deviceId: async () => 'fixture-device',
    fetch: async () => { assert.fail('no authentication request is needed') } })
  try {
    const coding = await auth.snapshot('zai')
    auth.markState(coding, 'quota_exhausted', 'QUOTA_EXHAUSTED')
    const start = await auth.snapshot('zai', undefined, 'start-plan')
    assert.equal((await auth.status('zai')).state, 'quota_exhausted')
    assert.deepEqual(await auth.status('zai', 'start-plan'), {
      platform: 'zai', plan: 'start-plan', state: 'ready', generation: coding.generation,
      authMode: 'oauth', scope: coding.scope,
    })
    assert.deepEqual(await auth.credential(start), {
      token: 'fixture-zcode', revision: coding.generation, kind: 'start-plan', deviceId: 'fixture-device',
    })
    auth.markState(start, 'quota_exhausted', 'ZCODE_START_QUOTA_EXHAUSTED')
    assert.equal((await auth.status('zai', 'start-plan')).state, 'ready')
    assert.equal((await auth.status('zai')).state, 'quota_exhausted')
  } finally { auth.dispose() }
})

test('manual Coding Plan credentials require browser login for Start Plan only', async () => {
  const auth = new ZcodeAuth({ store: store() })
  try {
    await auth.useApiKey('zai', 'fixture-key')
    const start = await auth.status('zai', 'start-plan')
    assert.equal(start.state, 'reauth_required')
    assert.equal(start.errorCode, 'ZCODE_START_LOGIN_REQUIRED')
    await assert.rejects(auth.snapshot('zai', undefined, 'start-plan'), /ZCODE_START_LOGIN_REQUIRED/)
    assert.equal((await auth.status('zai')).state, 'ready')
    assert.equal((await auth.credential(await auth.snapshot('zai'))).token, 'fixture-key')
  } finally { auth.dispose() }
})

test('Start Plan quotas retain each active plan and bucket, coalesce reads, and allow one waiter to cancel', async () => {
  let now = 1_700_000_000_000
  let calls = 0
  const gate = deferred<Response>()
  const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version
  const response = () => Response.json({ code: 0, data: {
    server_time: now / 1000 - 100_000,
    plans: [
      { plan_id: 'fixture-global', name: 'Global Build', status: 'active', ends_at: String(now / 1000 + 3600) },
      { plan_id: 'fixture-start', name: 'Start Plan', status: 'active', ends_at: now / 1000 + 7200 },
      { plan_id: 'fixture-expired', name: 'Expired', status: 'active', ends_at: now / 1000 - 1 },
    ],
    balances: [
      { plan_id: 'fixture-global', show_name: 'GLM-5.3-Flash', remaining_units: '300', total_units: 300, unit_type: 'tokens', expires_at: now / 1000 + 1800 },
      { plan_id: 'fixture-start', capabilities: ['model:GLM-5.3'], available_units: 60, total_units: 100, unit_type: 'tokens', expires_at: String(now / 1000 + 5400) },
      { plan_id: 'fixture-expired', show_name: 'Expired bucket', remaining_units: 10 },
      { plan_id: 'fixture-unmatched', show_name: 'Unmatched bucket', remaining_units: 10 },
    ],
  } }, { headers: { date: new Date(now).toUTCString() } })
  const auth = new ZcodeAuth({ store: store(grant()), now: () => now, deviceId: async () => 'fixture-device', fetch: async (input, init) => {
    calls++
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://zcode.z.ai')
    assert.equal(url.pathname, '/api/v1/zcode-plan/billing/balance')
    assert.equal(url.searchParams.get('app_version'), version)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-zcode')
    assert.equal(new Headers(init?.headers).get('x-device-mid'), 'fixture-device')
    assert.equal(new Headers(init?.headers).has('x-api-key'), false)
    assert.equal(init?.redirect, 'error')
    return calls === 1 ? gate.promise : response()
  } })
  try {
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    const controller = new AbortController()
    const cancelled = auth.queryQuota(snapshot, controller.signal)
    const remaining = auth.queryQuota(snapshot)
    await until(() => calls === 1)
    controller.abort()
    await assert.rejects(cancelled)
    gate.resolve(response())
    const quota = await remaining
    assert.deepEqual(quota.windows, [
      { name: 'Global Build · GLM-5.3-Flash', remaining: 300, limit: 300, resetsAt: now + 1_800_000, unit: 'tokens' },
      { name: 'Start Plan · GLM-5.3', remaining: 60, limit: 100, resetsAt: now + 5_400_000, unit: 'tokens' },
    ])
    assert.equal(JSON.stringify(quota).includes('fixture-zcode'), false)
    assert.equal((await auth.status('zai', 'start-plan')).state, 'ready')
    await auth.queryQuota(snapshot)
    assert.equal(calls, 1)
    await auth.queryQuota(snapshot, undefined, true)
    assert.equal(calls, 2)
    now += 60_000
    await auth.queryQuota(snapshot)
    assert.equal(calls, 3)
  } finally { auth.dispose() }
})

test('a late Start Plan quota response cannot attach to a changed account', async () => {
  const storage = store(grant())
  const gate = deferred<Response>()
  let calls = 0
  const auth = new ZcodeAuth({ store: storage, now: () => 1_700_000_000_000, deviceId: async () => 'fixture-device',
    fetch: async () => {
      calls++
      if (calls === 1) return gate.promise
      return Response.json({ code: 0, data: {
        plans: [{ plan_id: 'new-plan', name: 'New plan', status: 'active' }],
        balances: [{ plan_id: 'new-plan', show_name: 'GLM-5.3', remaining_units: 1 }],
      } })
    },
  })
  try {
    const original = await auth.snapshot('zai', undefined, 'start-plan')
    const pending = auth.queryQuota(original)
    await until(() => calls === 1)
    storage.records.set('zai', grant('fixture-new-scope', 'fixture-new-zcode'))
    gate.resolve(Response.json({ code: 0, data: {
      plans: [{ plan_id: 'old-plan', name: 'Old plan', status: 'active' }],
      balances: [{ plan_id: 'old-plan', show_name: 'GLM-5.3', remaining_units: 3 }],
    } }))
    await assert.rejects(pending, /ZCODE_ACCOUNT_CHANGED/)
    assert.equal(original.signal.aborted, true)
    const current = await auth.snapshot('zai', undefined, 'start-plan')
    assert.deepEqual((await auth.queryQuota(current)).windows, [{ name: 'New plan · GLM-5.3', remaining: 1 }])
    assert.equal(calls, 2)
  } finally { auth.dispose() }
})

test('an expired Start Plan login requires reauthorization without exposing provider messages', async () => {
  const auth = new ZcodeAuth({ store: store(grant()), deviceId: async () => 'fixture-device',
    fetch: async () => Response.json({ code: 1006, msg: 'fixture-sensitive-message' }) })
  try {
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    await assert.rejects(auth.queryQuota(snapshot), (error: unknown) =>
      error instanceof AuthError && error.code === 'ZCODE_LOGIN_REQUIRED' && !error.message.includes('fixture-sensitive-message'))
    assert.equal((await auth.status('zai', 'start-plan')).state, 'reauth_required')
    assert.equal((await auth.status('zai')).state, 'reauth_required')
  } finally { auth.dispose() }
})
