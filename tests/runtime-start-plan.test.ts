import assert from 'node:assert/strict'
import test from 'node:test'
import { ZCodeRuntime } from '../src/runtime.js'
import type { AccountSnapshot, AccountStatus, AuthPort, Plan, Platform, QuotaSnapshot } from '../src/types.js'

function fixture() {
  let generation = 1
  let scope = 'fixture-first'
  let controller = new AbortController()
  const seen: { plan: Plan; force?: boolean }[] = []
  let quota: (snapshot: AccountSnapshot) => Promise<QuotaSnapshot> = async snapshot => ({
    updatedAt: 1, windows: [{ name: snapshot.plan === 'start-plan' ? 'Start Plan' : 'Coding Plan', remaining: snapshot.plan === 'start-plan' ? 7 : 0 }],
  })
  const account = (platform: Platform, plan: Plan = 'coding-plan'): AccountStatus => platform === 'zai'
    ? { platform, plan, state: plan === 'start-plan' ? 'ready' : 'quota_exhausted', authMode: 'oauth', scope, generation }
    : { platform, plan, state: 'signed_out', generation: 0 }
  const auth: AuthPort = {
    async status(platform, plan) { return account(platform, plan) },
    async snapshot(platform, _signal, plan = 'coding-plan') {
      return { platform, plan, scope, generation, mode: 'oauth', signal: controller.signal }
    },
    async queryQuota(snapshot, _signal, force) { seen.push({ plan: snapshot.plan ?? 'coding-plan', force }); return quota(snapshot) },
    async beginLogin() { throw new Error('unexpected login') },
    async waitForLogin() { throw new Error('unexpected login') },
    async cancelLogin() { throw new Error('unexpected login') },
    async disconnect() { throw new Error('unexpected disconnect') },
    async useApiKey() { throw new Error('unexpected key change') },
    async credential() { throw new Error('unexpected credential request') },
    reject() { throw new Error('unexpected credential rejection') },
    markState() { throw new Error('unexpected state change') },
    dispose() {},
  }
  return {
    auth, seen, account,
    changeAccount() { controller.abort(); controller = new AbortController(); generation++; scope = 'fixture-second' },
    setQuota(callback: typeof quota) { quota = callback },
  }
}

const settings = () => ({ platform: 'zai' as const, concurrency: 2, maxTokens: 32000, timeoutMs: 300000, effort: 'high' as const })

test('runtime keeps Start Plan quota and model updates separate from Coding Plan', async () => {
  const source = fixture()
  const updates: string[] = []
  const runtime = new ZCodeRuntime(source.auth, settings, provider => updates.push(provider))
  try {
    runtime.onAccountChanged(source.account('zai'))
    assert.deepEqual(updates, ['zcode-zai', 'zcode-zai-start-plan'])
    let view = await runtime.readQuota('zai')
    view = await runtime.readQuota('zai', 'start-plan')
    const coding = view.quotas.find(item => item.platform === 'zai' && item.plan === 'coding-plan')
    const start = view.quotas.find(item => item.platform === 'zai' && item.plan === 'start-plan')
    assert.equal(coding?.snapshot?.windows[0].remaining, 0)
    assert.equal(start?.snapshot?.windows[0].remaining, 7)
    assert.equal(view.accounts.find(item => item.platform === 'zai' && item.plan === 'coding-plan')?.state, 'quota_exhausted')
    assert.equal(view.accounts.find(item => item.platform === 'zai' && item.plan === 'start-plan')?.state, 'ready')
    assert.deepEqual(source.seen.map(item => item.plan), ['coding-plan', 'start-plan'])
    await runtime.refreshQuota('zai', 'start-plan')
    assert.deepEqual(source.seen.at(-1), { plan: 'start-plan', force: true })
    await runtime.refreshModels('zai', 'start-plan')
    assert.equal(updates.at(-1), 'zcode-zai-start-plan')
    source.changeAccount()
    runtime.onAccountChanged(source.account('zai'))
    view = await runtime.status()
    assert.ok(view.quotas.filter(item => item.platform === 'zai').every(item => item.snapshot === undefined))
  } finally { runtime.dispose() }
})

test('late Start Plan quota results cannot restore an older account view', async () => {
  const source = fixture()
  let complete!: (value: QuotaSnapshot) => void
  const quota = new Promise<QuotaSnapshot>(resolve => { complete = resolve })
  source.setQuota(() => quota)
  const runtime = new ZCodeRuntime(source.auth, settings, () => {})
  try {
    runtime.onAccountChanged(source.account('zai'))
    const pending = runtime.readQuota('zai', 'start-plan')
    await Promise.resolve()
    source.changeAccount()
    runtime.onAccountChanged(source.account('zai'))
    complete({ updatedAt: 1, windows: [{ name: 'Start Plan', remaining: 9 }] })
    const view = await pending
    assert.equal(view.quotas.find(item => item.platform === 'zai' && item.plan === 'start-plan')?.snapshot, undefined)
  } finally { runtime.dispose() }
})
