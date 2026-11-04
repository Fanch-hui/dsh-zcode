import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attributionHeaders, LlmError, MessageId, ToolCallId,
  type ContentBlock, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Settings } from '../src/config.js'
import { ZcodeAuth, type CredentialStore, type StoredAccount } from '../src/auth/index.js'
import { ZCodeAdapter } from '../src/provider/adapter.js'
import { upstreamSession } from '../src/provider/session.js'
import type { Platform } from '../src/types.js'

const defaults: Settings = { platform: 'bigmodel', concurrency: 2, maxTokens: 32000, timeoutMs: 10000, effort: 'high' }
const options: GenerateOptions = { provider: 'zcode-bigmodel', model: 'GLM-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'read file' }] }] }

function memory(initial?: StoredAccount, platform: Platform = 'bigmodel'): CredentialStore {
  const records = new Map<Platform, StoredAccount>(initial ? [[platform, initial]] : [])
  return {
    async load(platform) { return records.get(platform) },
    async save(platform, value, check) { check(); records.set(platform, value) },
    async remove(platform, check) { check(); records.delete(platform) },
  }
}
function stream(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
function answer(content: Record<string, unknown>, reason = 'end_turn'): Response {
  return stream([
    { type: 'message_start', message: { id: 'fixture-response', usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])
}
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of chunks) result.push(chunk)
  return result
}

test('native adapter sends attributed Coding Plan requests and completes a real tool-result protocol round trip', async () => {
  const auth = new ZcodeAuth({ store: memory() })
  await auth.useApiKey('bigmodel', 'fixture-key')
  let calls = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => defaults, fetch: async (url, init) => {
    assert.equal(String(url), 'https://open.bigmodel.cn/api/anthropic/v1/messages')
    assert.equal(init?.redirect, 'error')
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(attributionHeaders())) assert.equal(headers.get(name), value)
    assert.equal(headers.get('x-api-key'), 'fixture-key')
    assert.equal(headers.get('authorization'), 'Bearer fixture-key')
    const body = JSON.parse(String(init?.body))
    calls++
    if (calls === 1) return answer({ type: 'tool_use', id: 'fixture-call', name: 'read_file', input: { path: 'a.txt' } }, 'tool_use')
    assert.deepEqual(body.messages[1].content[0], { type: 'tool_use', id: 'fixture-call', name: 'read_file', input: { path: 'a.txt' } })
    assert.equal(body.messages[2].content[0].tool_use_id, 'fixture-call')
    return answer({ type: 'text', text: 'contents received' })
  } })
  const first = await collect(adapter.stream(options))
  const end = first.find(chunk => chunk.type === 'block-end')!
  const terminal = first.at(-1)!
  assert.equal(end.type, 'block-end')
  assert.equal(terminal.type, 'finish')
  if (end.type !== 'block-end' || terminal.type !== 'finish') throw new Error('missing tool call')
  assert.deepEqual(terminal.reason, { kind: 'tool-calls' })
  const second = await collect(adapter.stream({ ...options, messages: [...options.messages,
    { role: 'assistant', id: MessageId('fixture-assistant'), source: { kind: 'model', provider: options.provider, model: options.model, replayState: terminal.replayState }, content: [end.block] },
    { role: 'tool', id: MessageId('fixture-result'), source: { kind: 'tool', callId: ToolCallId('fixture-call') }, toolCallId: ToolCallId('fixture-call'), content: [{ type: 'text', text: 'file content' }] },
  ] }))
  assert.deepEqual(second.at(-1)?.type === 'finish' && (second.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason, { kind: 'stop' })
  assert.equal(calls, 2)
  adapter.dispose(); auth.dispose()
})

test('a PAT rejection consumes one attempt and the next DSH retry obtains a new PAT', async () => {
  const record: StoredAccount = { kind: 'grant', payload: {
    schemaVersion: 1, platform: 'bigmodel', scope: 'fixture-scope', oauthAccessToken: 'fixture-oauth', zcodeToken: 'fixture-zcode',
    location: { organizationId: 'org', projectId: 'project', apiKeyId: 'metadata-id' },
  } }
  let issued = 0
  const auth = new ZcodeAuth({ store: memory(record), fetch: async () => Response.json({ code: 0, data: {
    accessToken: `fixture-pat-${++issued}`, tokenType: 'Bearer', expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
  } }) })
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => defaults, fetch: async (url, init) => {
    if (String(url) === 'https://zcode.z.ai/api/v1/agent/configs') {
      assert.equal(new Headers(init?.headers).get('x-api-key-id'), 'metadata-id')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return Response.json({ code: 0, data: { proxyEndpoint: { mapping: [{
        from: 'https://open.bigmodel.cn/api/anthropic/v1/messages',
        to: 'https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages',
        zcodeAuthorizationHeader: 'X-ZCode-Authorization',
      }] } } })
    }
    assert.equal(String(url), 'https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages')
    assert.equal(new Headers(init?.headers).get('x-api-key'), `fixture-pat-${requests + 1}`)
    assert.equal(new Headers(init?.headers).get('x-zcode-authorization'), 'Bearer fixture-zcode')
    return ++requests === 1 ? new Response('', { status: 401 }) : answer({ type: 'text', text: 'ok' })
  } })
  const controller = new AbortController()
  const prepared = await adapter.prepareCall(options.provider, options.model, controller.signal)
  await assert.rejects(collect(prepared.stream({ ...options, signal: controller.signal })), (error: unknown) => error instanceof LlmError && error.code === 'ZCODE_PAT_REJECTED')
  assert.equal(requests, 1)
  await collect((await adapter.prepareCall(options.provider, options.model, controller.signal)).stream({ ...options, signal: controller.signal }))
  assert.equal(issued, 2)
  assert.equal(requests, 2)
  assert.equal(adapter.providerRetryPolicy().mode, 'normal')
  adapter.dispose(); auth.dispose()
})

test('Z.AI OAuth quota failures mark account state and block further model attempts', async () => {
  const record: StoredAccount = { kind: 'grant', payload: {
    schemaVersion: 1, platform: 'zai', scope: 'fixture-zai-scope', oauthAccessToken: 'fixture-oauth', zcodeToken: 'fixture-zcode',
    location: { organizationId: 'org', projectId: 'project', apiKeyId: 'metadata-id' },
  } }
  const auth = new ZcodeAuth({ store: memory(record, 'zai'), fetch: async () => Response.json({ code: 0, data: {
    accessToken: 'fixture-zai-pat', tokenType: 'Bearer', expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
  } }) })
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => ({ ...defaults, platform: 'zai' }), fetch: async (url, init) => {
    if (String(url) === 'https://zcode.z.ai/api/v1/agent/configs') {
      return Response.json({ code: 0, data: { proxyEndpoint: { mapping: [] } } })
    }
    requests++
    assert.equal(String(url), 'https://api.z.ai/api/anthropic/v1/messages')
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fixture-zai-pat')
    return Response.json({ error: { code: '1308', message: 'fixture quota limit' } }, { status: 429 })
  } })
  const zaiOptions = { ...options, provider: 'zcode-zai' }
  try {
    await assert.rejects(collect(adapter.stream(zaiOptions)), (error: unknown) =>
      error instanceof LlmError && error.code === 'QUOTA_EXHAUSTED' && /1308/.test(error.message))
    assert.equal((await auth.status('zai')).state, 'quota_exhausted')
    await assert.rejects(adapter.prepareCall('zcode-zai', 'GLM-5.3'), (error: unknown) =>
      error instanceof LlmError && error.code === 'QUOTA_EXHAUSTED')
    assert.equal(requests, 1)
    const policy = adapter.providerRetryPolicy()
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes('QUOTA_EXHAUSTED'), false)
  } finally { adapter.dispose(); auth.dispose() }
})

test('prepared requests freeze settings and never switch to a newly selected account', async () => {
  const auth = new ZcodeAuth({ store: memory() })
  await auth.useApiKey('bigmodel', 'fixture-old')
  let settings = { ...defaults }
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => settings, fetch: async (_url, init) => {
    requests++
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 32000)
    return answer({ type: 'text', text: 'ok' })
  } })
  const controller = new AbortController()
  const prepared = await adapter.prepareCall(options.provider, options.model, controller.signal)
  settings = { ...defaults, maxTokens: 64000 }
  await collect(prepared.stream({ ...options, signal: controller.signal }))
  await auth.useApiKey('bigmodel', 'fixture-new')
  const chunks = await collect(prepared.stream({ ...options, signal: controller.signal }))
  assert.equal(chunks.at(-1)?.type === 'finish' && (chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason.kind, 'aborted')
  await assert.rejects(adapter.prepareCall(options.provider, options.model, controller.signal))
  assert.equal(requests, 1)
  adapter.dispose(); auth.dispose()
})

test('consumer early return cancels the HTTP stream and frees the concurrency slot', async () => {
  const auth = new ZcodeAuth({ store: memory() })
  await auth.useApiKey('bigmodel', 'fixture-key')
  let cancelled = false
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => ({ ...defaults, concurrency: 1 }), fetch: async () => {
    requests++
    if (requests > 1) return answer({ type: 'text', text: 'ok' })
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}\n\n')) },
      cancel() { cancelled = true },
    }))
  } })
  const iterator = adapter.stream(options)
  await iterator.next()
  await iterator.return(undefined)
  assert.equal(cancelled, true)
  await collect(adapter.stream(options))
  assert.equal(requests, 2)
  adapter.dispose(); auth.dispose()
})

test('an interrupted answer preserves emitted content and does not enter the transient retry budget', async () => {
  const auth = new ZcodeAuth({ store: memory() })
  await auth.useApiKey('bigmodel', 'fixture-key')
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => defaults, fetch: async () => {
    requests++
    return stream([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } },
    ])
  } })
  const content: ContentBlock[] = []
  await assert.rejects((async () => {
    for await (const chunk of adapter.stream(options)) if (chunk.type === 'text-delta') content.push({ type: 'text', text: chunk.text })
  })(), (error: unknown) => error instanceof LlmError && error.code === 'ZCODE_STREAM_INTERRUPTED')
  assert.deepEqual(content, [{ type: 'text', text: 'partial' }])
  assert.equal(requests, 1)
  const policy = adapter.providerRetryPolicy()
  assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes('ZCODE_STREAM_INTERRUPTED'), false)
  adapter.dispose(); auth.dispose()
})

test('session routing isolates accounts, models, child sessions and auxiliary purposes', () => {
  const account = { platform: 'bigmodel' as const, scope: 'fixture-scope', generation: 1, mode: 'api-key' as const, signal: new AbortController().signal }
  const request = { ...options, sessionId: 'fixture-session' } as GenerateOptions<string>
  const original = upstreamSession('profile', account, request)
  assert.equal(original, upstreamSession('profile', { ...account, generation: 2 }, request))
  const variants = [
    upstreamSession('profile2', account, request),
    upstreamSession('profile', { ...account, scope: 'another' }, request),
    upstreamSession('profile', account, { ...request, model: 'GLM-5.3-Flash' }),
    upstreamSession('profile', account, { ...request, sessionId: 'fixture-child' } as GenerateOptions<string>),
    upstreamSession('profile', account, { ...request, purpose: 'title' } as GenerateOptions<string>),
  ]
  assert.equal(new Set([original, ...variants]).size, 6)
})
