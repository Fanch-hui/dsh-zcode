import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ZCodeAdapter } from '../src/provider/adapter.js'
import type { Settings } from '../src/config.js'
import type { AccountSnapshot, AccountState, AuthPort, Plan, Platform, RequestCredential } from '../src/types.js'

const settings: Settings = { platform: 'zai', plan: 'start-plan', concurrency: 2, maxTokens: 32000, timeoutMs: 10000, effort: 'high' }
const options: GenerateOptions = { provider: 'zcode-zai-start-plan', model: 'GLM-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'read a file' }] }] }

class TestAuth implements AuthPort {
  private readonly controller = new AbortController()
  private readonly states = new Map<Plan, AccountState>()
  async status(platform: Platform, plan: Plan = 'coding-plan') {
    return { platform, plan, generation: 1, scope: 'fixture-scope', state: this.states.get(plan) ?? 'ready' as AccountState }
  }
  async snapshot(platform: Platform, _signal?: AbortSignal, plan: Plan = 'coding-plan'): Promise<AccountSnapshot> {
    return { platform, plan, scope: 'fixture-scope', generation: 1, mode: 'oauth', signal: this.controller.signal }
  }
  async credential(account: AccountSnapshot): Promise<RequestCredential> {
    const port = account.plan === 'start-plan' ? 48102 : 48101
    return { kind: 'proxy', token: 'fixture-local-key', revision: 1,
      url: `http://127.0.0.1:${port}/v1/messages` }
  }
  markState(account: AccountSnapshot, state: 'reauth_required' | 'quota_exhausted'): void {
    this.states.set(account.plan ?? 'coding-plan', state)
  }
  async beginLogin(): Promise<never> { throw new Error('unused') }
  async waitForLogin(): Promise<void> { throw new Error('unused') }
  async cancelLogin(): Promise<void> { throw new Error('unused') }
  async disconnect(): Promise<void> { throw new Error('unused') }
  async useApiKey(): Promise<void> { throw new Error('unused') }
  async queryQuota(): Promise<never> { throw new Error('unused') }
  reject(): void {}
  dispose(): void { this.controller.abort() }
}

function answer(): Response {
  const events = [
    { type: 'message_start', message: { id: 'fixture-response' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'file received' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

async function collect(chunks: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of chunks) result.push(chunk)
  return result
}

test('Start Plan selects its own proxy and remains usable when Coding Plan quota is exhausted', async () => {
  const account = new TestAuth()
  account.markState(await account.snapshot('zai'), 'quota_exhausted')
  let requests = 0
  const adapter = new ZCodeAdapter({ auth: account, settings: () => settings, fetch: async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:48102/v1/messages')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer fixture-local-key')
    assert.equal(headers.get('x-api-key'), 'fixture-local-key')
    assert.equal(headers.get('x-device-mid'), null)
    assert.equal(headers.get('x-zcode-authorization'), null)
    requests++
    return answer()
  } })
  try {
    const prepared = await adapter.prepareCall(options.provider, options.model)
    await assert.rejects(collect(prepared.stream({ ...options, provider: 'zcode-zai' })),
      (error: unknown) => error instanceof LlmError && error.code === 'AUTH')
    assert.equal(requests, 0)
    const result = await collect(adapter.stream(options))
    assert.deepEqual(result.at(-1)?.type === 'finish' && (result.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason, { kind: 'stop' })
    assert.equal(requests, 1)
    assert.equal((await account.status('zai')).state, 'quota_exhausted')
    assert.equal((await account.status('zai', 'start-plan')).state, 'ready')
  } finally { adapter.dispose(); account.dispose() }
})

test('Start Plan applies the selected model capabilities and preserves the existing 5.3 route', async () => {
  const account = new TestAuth()
  const bodies: Record<string, unknown>[] = []
  const adapter = new ZCodeAdapter({ auth: account, settings: () => ({ ...settings, maxTokens: 128000, effort: 'low' }),
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return answer() } })
  try {
    const glm52 = await adapter.resolveModel(options.provider, 'GLM-5.2')
    assert.deepEqual(glm52.inputModalities, ['text'])
    assert.equal(glm52.context?.contextWindow, 1_000_000)
    assert.equal(glm52.defaultMaxTokens, 128000)
    assert.deepEqual(glm52.reasoning?.efforts.map(item => item.id), ['off', 'high', 'max'])
    assert.equal(glm52.reasoning?.defaultEffort, 'high')
    const turbo = await adapter.resolveModel(options.provider, 'GLM-5-Turbo')
    assert.deepEqual(turbo.inputModalities, ['text'])
    assert.equal(turbo.context?.contextWindow, 200_000)
    assert.equal(turbo.defaultMaxTokens, 64000)
    assert.deepEqual(turbo.reasoning?.efforts.map(item => item.id), ['off', 'high'])
    assert.equal(turbo.reasoning?.defaultEffort, 'high')

    for (const [model, effort, maxTokens, thinking, output] of [
      ['GLM-5.2', 'off', 128000, 'disabled', undefined],
      ['GLM-5.2', 'high', 128000, 'enabled', { effort: 'high' }],
      ['GLM-5.2', 'max', 128000, 'enabled', { effort: 'max' }],
      ['GLM-5-Turbo', 'off', 64000, 'disabled', undefined],
      ['GLM-5-Turbo', 'high', 64000, 'enabled', undefined],
      ['GLM-5.3', 'low', 128000, 'enabled', { effort: 'low' }],
    ] as const) {
      await collect(adapter.stream({ ...options, model, reasoningEffort: ReasoningEffortId(effort), maxTokens }))
      const body = bodies.at(-1)!
      assert.equal(body.model, model)
      assert.equal(body.max_tokens, maxTokens)
      assert.deepEqual(body.thinking, { type: thinking })
      assert.deepEqual(body.output_config, output)
    }
    await collect(adapter.stream({ ...options, model: 'GLM-5-Turbo' }))
    assert.equal(bodies.at(-1)?.max_tokens, 64000)
    assert.deepEqual(bodies.at(-1)?.thinking, { type: 'enabled' })
    await assert.rejects(collect(adapter.stream({ ...options, model: 'GLM-5-Turbo', maxTokens: 64001 })),
      (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED_OPTION')
    await assert.rejects(collect(adapter.stream({ ...options, model: 'GLM-5.2', reasoningEffort: ReasoningEffortId('low') })),
      (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED_OPTION')
    assert.equal(bodies.length, 7)
  } finally { adapter.dispose(); account.dispose() }
})

test('a Start Plan quota rejection leaves the shared login usable for the next attempt', async () => {
  const account = new TestAuth()
  let requests = 0
  const adapter = new ZCodeAdapter({ auth: account, settings: () => settings, fetch: async () => {
    return ++requests === 1 ? Response.json({ code: 1005, msg: 'fixture limited' }) : answer()
  } })
  try {
    await assert.rejects(collect(adapter.stream(options)), (error: unknown) => error instanceof LlmError && error.code === 'QUOTA_EXHAUSTED' && /1005/.test(error.message))
    assert.equal((await account.status('zai')).state, 'ready')
    assert.equal((await account.status('zai', 'start-plan')).state, 'ready')
    assert.equal((await collect(adapter.stream(options))).at(-1)?.type, 'finish')
    assert.equal(requests, 2)
    const policy = adapter.providerRetryPolicy(options.provider)
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes('RATE_LIMIT'), false)
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes('QUOTA_EXHAUSTED'), false)
  } finally { adapter.dispose(); account.dispose() }
})
