import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError, MessageId, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ZcodeAuth, type CredentialStore, type StoredAccount } from '../src/auth/index.js'
import { ZCodeAdapter } from '../src/provider/adapter.js'
import type { Settings } from '../src/config.js'

const settings: Settings = { platform: 'zai', plan: 'start-plan', concurrency: 2, maxTokens: 32000, timeoutMs: 10000, effort: 'high' }
const options: GenerateOptions = { provider: 'zcode-zai-start-plan', model: 'GLM-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'read a file' }] }] }

function auth(): ZcodeAuth {
  let record: StoredAccount | undefined = { kind: 'grant', payload: {
    schemaVersion: 1, platform: 'zai', scope: 'fixture-scope', oauthAccessToken: 'fixture-oauth', zcodeToken: 'fixture-plan-jwt',
  } }
  const store: CredentialStore = {
    async load(platform) { return platform === 'zai' ? record : undefined },
    async save(_platform, value, check) { check(); record = value },
    async remove(_platform, check) { check(); record = undefined },
  }
  return new ZcodeAuth({ store, deviceId: async () => 'fixture-device', fetch: async () => { throw new Error('Start Plan must not issue a paid PAT') } })
}

function answer(content: Record<string, unknown>, stop = 'end_turn'): Response {
  const events = [
    { type: 'message_start', message: { id: 'fixture-response' } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

async function collect(chunks: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of chunks) result.push(chunk)
  return result
}

test('Start Plan uses the existing OAuth JWT and completes a DSH tool round trip independently of paid quota', async () => {
  const account = auth()
  account.markState(await account.snapshot('zai'), 'quota_exhausted', 'QUOTA_EXHAUSTED')
  let requests = 0
  const adapter = new ZCodeAdapter({ auth: account, settings: () => settings, fetch: async (url, init) => {
    assert.equal(String(url), 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer fixture-plan-jwt')
    assert.equal(headers.get('x-api-key'), 'fixture-plan-jwt')
    assert.equal(headers.get('x-device-mid'), 'fixture-device')
    assert.equal(headers.get('x-zcode-authorization'), null)
    requests++
    if (requests === 1) return answer({ type: 'tool_use', id: 'fixture-tool', name: 'read_file', input: { path: 'a.txt' } }, 'tool_use')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.messages.at(-1).content[0].tool_use_id, 'fixture-tool')
    return answer({ type: 'text', text: 'file received' })
  } })
  try {
    const prepared = await adapter.prepareCall(options.provider, options.model)
    await assert.rejects(collect(prepared.stream({ ...options, provider: 'zcode-zai' })),
      (error: unknown) => error instanceof LlmError && error.code === 'AUTH')
    assert.equal(requests, 0)
    const first = await collect(adapter.stream(options))
    const end = first.find(chunk => chunk.type === 'block-end')!
    const finish = first.at(-1)!
    if (end.type !== 'block-end' || finish.type !== 'finish') throw new Error('missing tool response')
    assert.deepEqual(finish.reason, { kind: 'tool-calls' })
    const second = await collect(adapter.stream({ ...options, messages: [...options.messages,
      { role: 'assistant', id: MessageId('fixture-assistant'), source: { kind: 'model', provider: options.provider, model: options.model, replayState: finish.replayState }, content: [end.block] },
      { role: 'tool', id: MessageId('fixture-result'), source: { kind: 'tool', callId: ToolCallId('fixture-tool') }, toolCallId: ToolCallId('fixture-tool'), content: [{ type: 'text', text: 'file text' }] },
    ] }))
    assert.deepEqual(second.at(-1)?.type === 'finish' && (second.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason, { kind: 'stop' })
    assert.equal(requests, 2)
    assert.equal((await account.status('zai')).state, 'quota_exhausted')
    assert.equal((await account.status('zai', 'start-plan')).state, 'ready')
  } finally { adapter.dispose(); account.dispose() }
})

test('a Start Plan quota rejection leaves the shared login usable for the next attempt', async () => {
  const account = auth()
  let requests = 0
  const adapter = new ZCodeAdapter({ auth: account, settings: () => settings, fetch: async () => {
    return ++requests === 1 ? Response.json({ code: 1005, msg: 'fixture limited' }) : answer({ type: 'text', text: 'ok' })
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
