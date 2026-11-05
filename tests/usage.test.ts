import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ZCodeAdapter } from '../src/provider/adapter.js'
import { ZCodeRuntime } from '../src/runtime.js'
import { statusSchema } from '../src/control/remote.js'
import { TokenUsageTracker } from '../src/usage.js'
import type { AuthPort } from '../src/types.js'
import type { Settings } from '../src/config.js'

const settings: Settings = { platform: 'bigmodel', concurrency: 2, maxTokens: 32000, timeoutMs: 10000, effort: 'high' }
const options: GenerateOptions = {
  provider: 'zcode-bigmodel', model: 'GLM-5.3',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

function fixtureAuth(): AuthPort {
  const account = { platform: 'bigmodel', plan: 'coding-plan', scope: 'fixture', generation: 1,
    mode: 'oauth', signal: new AbortController().signal }
  return {
    status: async (platform: string, plan = 'coding-plan') => ({ platform, plan, state: 'ready', generation: 1, scope: 'fixture' }),
    snapshot: async () => account,
    credential: async () => ({ kind: 'proxy', token: 'fixture-key', revision: 1, url: 'http://127.0.0.1:48101/v1/messages' }),
    reject: () => {},
  } as unknown as AuthPort
}

function answer(): Response {
  const events = [
    { type: 'message_start', message: { id: 'fixture', usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}

async function consume(chunks: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const chunk of chunks) void chunk
}

test('each model keeps its own usage totals while the overall sum is derived', async () => {
  const auth = fixtureAuth()
  const runtime = new ZCodeRuntime(auth, () => settings, () => {})
  const adapter = new ZCodeAdapter({ auth, settings: () => settings,
    fetch: async () => answer(), onUsage: (route, usage) => runtime.recordUsage(route, usage) })
  try {
    await consume(adapter.stream(options))
    await consume(adapter.stream(options))
    await consume(adapter.stream({ ...options, model: 'GLM-5.3-Flash' }))
    const status = await runtime.status()
    const byModel = new Map((status.usage?.models ?? []).map(item => [item.model, item] as const))
    assert.equal(byModel.size, 2)
    assert.deepEqual(byModel.get('GLM-5.3')?.totals, { total: 36, input: 30, output: 6, cacheRead: 10, cacheWrite: 0, hitRate: (5 / 15) * 100 })
    assert.equal(byModel.get('GLM-5.3')?.calls, 2)
    assert.deepEqual(byModel.get('GLM-5.3-Flash')?.totals, { total: 18, input: 15, output: 3, cacheRead: 5, cacheWrite: 0, hitRate: (5 / 15) * 100 })
    assert.equal(byModel.get('GLM-5.3-Flash')?.calls, 1)
    assert.deepEqual(status.usage?.totals, { total: 54, input: 45, output: 9, cacheRead: 15, cacheWrite: 0, hitRate: (5 / 15) * 100 })
    assert.equal(statusSchema.parse(status).usage?.models.length, 2)
  } finally { adapter.dispose(); runtime.dispose() }
})

test('the same model on different providers is tracked separately', () => {
  const tracker = new TokenUsageTracker()
  const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5 }
  tracker.record({ provider: 'zcode-bigmodel', model: 'GLM-5.3' }, usage)
  tracker.record({ provider: 'zcode-zai', model: 'GLM-5.3' }, usage)
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.models.length, 2)
  assert.deepEqual(snapshot.models.map(item => item.provider).sort(), ['zcode-bigmodel', 'zcode-zai'])
  assert.equal(snapshot.totals.total, 36)
})
