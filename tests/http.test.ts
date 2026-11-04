import assert from 'node:assert/strict'
import test from 'node:test'
import { httpFailure } from '../src/transport/http.js'
import type { AccountSnapshot, AuthPort, RequestCredential } from '../src/types.js'

const account: AccountSnapshot = {
  platform: 'zai', scope: 'fixture-account', generation: 1,
  mode: 'oauth', signal: new AbortController().signal,
}
const credential: RequestCredential = { kind: 'pat', token: 'fixture-pat', revision: 1 }

test('distinguishes temporary Z.AI restrictions from quota and permission failures sharing HTTP 429', async t => {
  const cases = [
    { upstream: '1302', code: 'RATE_LIMIT', message: '请求频率' },
    { upstream: 1305, code: 'SERVER', message: '服务暂时繁忙' },
    { upstream: '1113', code: 'QUOTA_EXHAUSTED', message: '余额不足' },
    { upstream: '1308', code: 'QUOTA_EXHAUSTED', message: '用量窗口' },
    { upstream: '1310', code: 'QUOTA_EXHAUSTED', message: '本周或本月' },
    { upstream: '1309', code: 'PERMISSION', message: '已到期' },
    { upstream: '1311', code: 'PERMISSION', message: '未包含所选模型' },
    { upstream: '1313', code: 'PERMISSION', message: '使用规则' },
    { upstream: '1314', code: 'PERMISSION', message: '企业套餐已到期' },
    { upstream: '1315', code: 'PERMISSION', message: '套餐类型' },
    { upstream: '1316', code: 'QUOTA_EXHAUSTED', message: '近 5 小时' },
    { upstream: '1317', code: 'QUOTA_EXHAUSTED', message: '近 7 天' },
    { upstream: '1318', code: 'QUOTA_EXHAUSTED', message: '费用上限' },
    { upstream: '1319', code: 'QUOTA_EXHAUSTED', message: '费用上限' },
    { upstream: '1320', code: 'QUOTA_EXHAUSTED', message: '费用上限' },
    { upstream: '1321', code: 'QUOTA_EXHAUSTED', message: '费用上限' },
  ]
  for (const expected of cases) await t.test(String(expected.upstream), async () => {
    const states: string[] = []
    const auth: Pick<AuthPort, 'reject' | 'markState'> = {
      reject() { assert.fail('HTTP 429 must retain the active credential') },
      markState(snapshot, state) { assert.equal(snapshot, account); states.push(state) },
    }
    const response = Response.json({ error: { code: expected.upstream, message: 'fixture-sensitive-value' } }, { status: 429 })
    const error = await httpFailure(response, account, credential, auth, 2000)
    assert.equal(error.code, expected.code)
    assert.equal(error.failure.status, 429)
    assert.match(error.message, new RegExp(expected.message))
    assert.match(error.message, new RegExp(`平台码 ${expected.upstream}`))
    assert.equal(error.message.includes('fixture-sensitive-value'), false)
    assert.deepEqual(states, expected.code === 'QUOTA_EXHAUSTED' ? ['quota_exhausted'] : [])
    assert.equal(error.failure.providerRetryAfterMs,
      ['RATE_LIMIT', 'SERVER'].includes(expected.code) ? 2000 : undefined)
    assert.equal(response.body?.locked, false)
  })
})

test('keeps unknown or malformed platform errors safe and bounds response consumption', async () => {
  const auth = {
    reject() { assert.fail('unexpected credential rejection') },
    markState() { assert.fail('unknown failure must not exhaust account quota') },
  }
  for (const body of ['not-json', JSON.stringify({ error: { code: 'fixture-sensitive-value' } }), '{}']) {
    const error = await httpFailure(new Response(body, { status: 429 }), account, credential, auth)
    assert.equal(error.code, 'RATE_LIMIT')
    assert.match(error.message, /HTTP 429/)
    assert.equal(error.message.includes('fixture-sensitive-value'), false)
  }
  const unknown = await httpFailure(Response.json({ error: { code: '1399' } }, { status: 429 }), account, credential, auth)
  assert.match(unknown.message, /平台码 1399/)
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16_385)) },
    cancel() { cancelled = true },
  }), { status: 429 })
  const error = await httpFailure(response, account, credential, auth)
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(cancelled, true)
  assert.equal(response.body?.locked, false)
})
