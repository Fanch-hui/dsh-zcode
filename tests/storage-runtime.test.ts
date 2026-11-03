import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ZcodeAuth, type StoredAccount } from '../src/auth/index.js'
import { DshCredentialStore } from '../src/storage/credentials.js'
import { ZCodeRuntime } from '../src/runtime.js'

function provider() {
  const records = new Map<string, CredentialRecord>()
  const service = {
    async readRecord(key: string) { return records.get(key) },
    async modifyRecord(key: string, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const value = await mutate(records.get(key))
      if (value !== undefined) records.set(key, structuredClone(value))
      return records.get(key)
    },
    async deleteRecord(key: string) { records.delete(key) },
  } as CredentialProvider
  return { records, service }
}
const grant: StoredAccount = { kind: 'grant', payload: {
  schemaVersion: 1, platform: 'bigmodel', scope: 'fixture-grant', oauthAccessToken: 'fixture-oauth', zcodeToken: 'fixture-zcode',
} }
const manual = (scope: string): StoredAccount => ({ kind: 'api-key', key: `fixture-${scope}`, env: { DSH_ZCODE_SCOPE: scope } })

test('credential transactions reject a stale Host and preserve the newly selected manual key', async () => {
  const { records, service } = provider()
  const a = new DshCredentialStore(service)
  const b = new DshCredentialStore(service)
  await a.save('bigmodel', grant, () => {}, undefined)
  const original = await a.load('bigmodel')
  const newer = manual('fixture-new')
  await b.save('bigmodel', newer, () => {}, await b.load('bigmodel'))
  await assert.rejects(a.save('bigmodel', grant, () => {}, original), /ZCODE_ACCOUNT_CHANGED/)
  await assert.rejects(a.remove('bigmodel', () => {}, original), /ZCODE_ACCOUNT_CHANGED/)
  assert.deepEqual(await b.load('bigmodel'), newer)
  assert.equal(records.size, 2)
  const last = manual('fixture-last')
  await b.save('bigmodel', last, () => {}, newer)
  assert.equal(records.size, 2)
  assert.deepEqual(await b.load('bigmodel'), last)
  await b.remove('bigmodel', () => {}, last)
  assert.equal(records.size, 1)
  assert.equal(await b.load('bigmodel'), undefined)
  assert.ok(!JSON.stringify([...records.values()]).includes('fixture-last'))
})

test('cancelled writes cannot change the active account and damaged pointers can be replaced', async () => {
  const { records, service } = provider()
  const store = new DshCredentialStore(service)
  await store.save('bigmodel', grant, () => {}, undefined)
  await assert.rejects(store.save('bigmodel', manual('cancelled'), () => { throw new Error('cancelled') }, grant))
  assert.deepEqual(await store.load('bigmodel'), grant)
  records.set(credentialKey('llm-zcode', 'bigmodel'), { kind: 'grant', payload: { authMode: 'api-key', scope: 'missing-key' } })
  const auth = new ZcodeAuth({ store })
  assert.equal((await auth.status('bigmodel')).state, 'error')
  await auth.useApiKey('bigmodel', 'fixture-replacement')
  const snapshot = await auth.snapshot('bigmodel')
  assert.equal((await auth.credential(snapshot)).token, 'fixture-replacement')
  await auth.disconnect('bigmodel')
  auth.dispose()
})

test('opening quota status uses the cache while a manual refresh requests fresh platform data', async () => {
  const { service } = provider()
  let requests = 0
  const auth = new ZcodeAuth({ store: new DshCredentialStore(service), fetch: async () => {
    requests++
    return Response.json({ code: 0, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 }] } })
  } })
  await auth.useApiKey('bigmodel', 'fixture-key')
  const runtime = new ZCodeRuntime(auth, () => ({ platform: 'bigmodel', concurrency: 2, maxTokens: 32000, timeoutMs: 300000, effort: 'high' }), () => {})
  const first = await runtime.readQuota('bigmodel')
  await runtime.readQuota('bigmodel')
  assert.equal(requests, 1)
  assert.equal(first.quotas[0].snapshot?.windows[0].usedPercent, 20)
  await runtime.refreshQuota('bigmodel')
  assert.equal(requests, 2)
  await runtime.disconnect('bigmodel')
  assert.equal((await runtime.status()).quotas[0].snapshot, undefined)
  runtime.dispose(); auth.dispose()
})
