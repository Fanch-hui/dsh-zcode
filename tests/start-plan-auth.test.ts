import assert from 'node:assert/strict'
import test from 'node:test'
import { ZcodeAuth, type CredentialStore, type StoredAccount } from '../src/auth/index.js'
import { deferred, FixtureUpstream } from './helpers/upstream.js'

function storage(initial?: StoredAccount) {
  let record = initial
  const store: CredentialStore & { replace(value: StoredAccount): void } = {
    replace(value) { record = value },
    async load(platform) { return platform === 'zai' ? record : undefined },
    async save(_platform, value, check) { check(); record = value },
    async remove(_platform, check) { check(); record = undefined },
  }
  return store
}

const grant: StoredAccount = { kind: 'grant', payload: {
  schemaVersion: 1, platform: 'zai', scope: 'fixture-scope',
  upstream: { provider: 'zai', apiKey: 'fixture-key', jwt: 'fixture-jwt' },
} }

test('quota views are scoped by plan and Coding Plan exhaustion does not block Start Plan', async () => {
  const upstream = new FixtureUpstream(method => method === 'quota' ? {
    balances: [{ showName: 'GLM-5.3', remainingUnits: 90, totalUnits: 100, expiresAt: 1_700_000_000 }],
    codingPlan: { limits: [{ type: 'TOKENS_LIMIT', percentage: 100, remaining: 0, total: 100 }] }, errors: [],
  } : undefined)
  const auth = new ZcodeAuth({ store: storage(grant), upstream, now: () => 1_700_000_000_000 })
  try {
    const coding = await auth.snapshot('zai')
    const codingQuota = await auth.queryQuota(coding)
    assert.equal(codingQuota.windows[0].usedPercent, 100)
    assert.equal((await auth.status('zai')).state, 'quota_exhausted')
    const start = await auth.snapshot('zai', undefined, 'start-plan')
    const startQuota = await auth.queryQuota(start)
    assert.deepEqual(startQuota.windows, [{ name: 'GLM-5.3', remaining: 90, limit: 100, resetsAt: 1_700_000_000_000 }])
    assert.equal((await auth.status('zai', 'start-plan')).state, 'ready')
    assert.equal((await auth.credential(start)).kind, 'proxy')
    assert.equal(upstream.calls.filter(call => call.method === 'quota').length, 2)
  } finally { auth.dispose() }
})

test('quota requests share one pending result, preserve it when a waiter cancels, and refresh explicitly', async () => {
  const response = deferred<unknown>()
  const entered = deferred<void>()
  let requests = 0
  const upstream = new FixtureUpstream(method => {
    if (method !== 'quota') return undefined
    requests++
    if (requests === 1) { entered.resolve(); return response.promise }
    return { balances: [{ showName: 'GLM', remainingUnits: 50, totalUnits: 100 }], codingPlan: null, errors: [] }
  })
  const auth = new ZcodeAuth({ store: storage(grant), upstream })
  try {
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    const controller = new AbortController()
    const cancelled = auth.queryQuota(snapshot, controller.signal)
    const remaining = auth.queryQuota(snapshot)
    await entered.promise
    controller.abort()
    await assert.rejects(cancelled)
    response.resolve({ balances: [{ showName: 'GLM', remainingUnits: 75, totalUnits: 100 }], codingPlan: null, errors: [] })
    assert.equal((await remaining).windows[0].remaining, 75)
    assert.equal((await auth.queryQuota(snapshot)).windows[0].remaining, 75)
    assert.equal(requests, 1)
    assert.equal((await auth.queryQuota(snapshot, undefined, true)).windows[0].remaining, 50)
    assert.equal(requests, 2)
  } finally { auth.dispose() }
})

test('a late quota response is rejected after an account replacement', async () => {
  const response = deferred<unknown>()
  const entered = deferred<void>()
  const upstream = new FixtureUpstream(method => {
    if (method === 'quota') { entered.resolve(); return response.promise }
  })
  const store = storage(grant)
  const auth = new ZcodeAuth({ store, upstream })
  try {
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    const pending = auth.queryQuota(snapshot)
    await entered.promise
    store.replace({ kind: 'api-key', key: 'fixture-new', env: { DSH_ZCODE_SCOPE: 'fixture-new-scope' } })
    response.resolve({ balances: [{ showName: 'old', remainingUnits: 1 }], errors: [] })
    await assert.rejects(pending, /ZCODE_ACCOUNT_CHANGED/)
    assert.equal((await auth.status('zai')).authMode, 'api-key')
  } finally { auth.dispose() }
})

test('Start Plan needs a plan credential and quota failures expose a fixed error', async () => {
  const missing: StoredAccount = { kind: 'grant', payload: {
    schemaVersion: 1, platform: 'zai', scope: 'fixture-scope', upstream: { provider: 'zai', apiKey: 'fixture-key' },
  } }
  const auth = new ZcodeAuth({ store: storage(missing), upstream: new FixtureUpstream() })
  try {
    const snapshot = await auth.snapshot('zai', undefined, 'start-plan')
    await assert.rejects(auth.credential(snapshot), /ZCODE_START_LOGIN_REQUIRED/)
  } finally { auth.dispose() }
  const upstream = new FixtureUpstream(method => method === 'quota'
    ? { balances: [], codingPlan: null, errors: ['balance: synthetic-private-detail'] } : undefined)
  const failed = new ZcodeAuth({ store: storage(grant), upstream })
  try {
    const snapshot = await failed.snapshot('zai', undefined, 'start-plan')
    await assert.rejects(failed.queryQuota(snapshot), /^AuthError: ZCODE_QUOTA_UNAVAILABLE$/)
  } finally { failed.dispose() }
})
