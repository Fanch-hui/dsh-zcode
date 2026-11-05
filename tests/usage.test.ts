import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ZCodeAdapter } from '../src/provider/adapter.js'
import { ZCodeRuntime } from '../src/runtime.js'
import { statusSchema } from '../src/control/remote.js'
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

test('completed calls accumulate token totals, cache reads and hit rate in Host status', async () => {
  const auth = fixtureAuth()
  const runtime = new ZCodeRuntime(auth, () => settings, () => {})
  const adapter = new ZCodeAdapter({ auth, settings: () => settings,
    fetch: async () => answer(), onUsage: usage => runtime.recordUsage(usage) })
  try {
    await consume(adapter.stream(options))
    const once = await runtime.status()
    assert.deepEqual(once.usage, { total: 18, input: 15, output: 3, cacheRead: 5, cacheWrite: 0, hitRate: (5 / 15) * 100 })

    await consume(adapter.stream(options))
    const twice = await runtime.status()
    assert.deepEqual(twice.usage, { total: 36, input: 30, output: 6, cacheRead: 10, cacheWrite: 0, hitRate: (5 / 15) * 100 })
    assert.deepEqual(statusSchema.parse(twice).usage, twice.usage)
  } finally { adapter.dispose(); runtime.dispose() }
})
