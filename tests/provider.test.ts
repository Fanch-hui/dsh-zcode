import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attributionHeaders, LlmError, MessageId, ToolCallId,
  type ContentBlock, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Settings } from '../src/config.js'
import { ZCodeAdapter } from '../src/provider/adapter.js'
import { upstreamSession } from '../src/provider/session.js'
import type { AccountSnapshot, AccountState, AuthPort, Plan, Platform, RequestCredential } from '../src/types.js'

const defaults: Settings = { platform: 'bigmodel', concurrency: 2, maxTokens: 32000, timeoutMs: 10000, effort: 'high' }
const options: GenerateOptions = { provider: 'zcode-bigmodel', model: 'GLM-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'read file' }] }] }

class TestAuth implements AuthPort {
  private controller = new AbortController()
  private generation = 1
  private states = new Map<string, AccountState>()

  async status(platform: Platform, plan: Plan = 'coding-plan') {
    return { platform, plan, generation: this.generation, scope: `fixture-${this.generation}`,
      state: this.states.get(`${platform}:${plan}`) ?? 'ready' as AccountState }
  }
  async snapshot(platform: Platform, _signal?: AbortSignal, plan: Plan = 'coding-plan'): Promise<AccountSnapshot> {
    return { platform, plan, scope: `fixture-${this.generation}`, generation: this.generation,
      mode: 'oauth', signal: this.controller.signal }
  }
  async credential(snapshot: AccountSnapshot, signal?: AbortSignal): Promise<RequestCredential> {
    signal?.throwIfAborted()
    snapshot.signal.throwIfAborted()
    const port = snapshot.plan === 'start-plan' ? 48102 : 48101
    return { kind: 'proxy', token: 'fixture-local-key', revision: 1,
      url: `http://127.0.0.1:${port}/v1/messages` }
  }
  markState(account: AccountSnapshot, state: 'reauth_required' | 'quota_exhausted'): void {
    this.states.set(`${account.platform}:${account.plan ?? 'coding-plan'}`, state)
  }
  rotate(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.generation++
    this.states.clear()
  }
  async beginLogin(): Promise<never> { throw new Error('unused') }
  async waitForLogin(): Promise<void> { throw new Error('unused') }
  async cancelLogin(): Promise<void> { throw new Error('unused') }
  async disconnect(): Promise<void> { this.rotate() }
  async useApiKey(): Promise<void> { throw new Error('unused') }
  async queryQuota(): Promise<never> { throw new Error('unused') }
  reject(): void {}
  dispose(): void { this.controller.abort() }
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

test('DSH tool calls and results round-trip through the local proxy', async () => {
  const auth = new TestAuth()
  let calls = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => defaults, fetch: async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:48101/v1/messages')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(attributionHeaders())) assert.equal(headers.get(name), value)
    assert.equal(headers.get('x-api-key'), 'fixture-local-key')
    assert.equal(headers.get('authorization'), 'Bearer fixture-local-key')
    assert.ok(headers.get('x-session-id'))
    assert.equal(headers.get('x-zcode-authorization'), null)
    assert.equal(headers.get('x-device-mid'), null)
    const body = JSON.parse(String(init?.body))
    calls++
    if (calls === 1) return answer({ type: 'tool_use', id: 'fixture-call', name: 'read_file', input: { path: 'a.txt' } }, 'tool_use')
    assert.deepEqual(body.messages[1].content[0], { type: 'tool_use', id: 'fixture-call', name: 'read_file', input: { path: 'a.txt' } })
    assert.equal(body.messages[2].content[0].tool_use_id, 'fixture-call')
    return answer({ type: 'text', text: 'contents received' })
  } })
  try {
    const first = await collect(adapter.stream(options))
    const end = first.find(chunk => chunk.type === 'block-end')!
    const terminal = first.at(-1)!
    if (end.type !== 'block-end' || terminal.type !== 'finish') throw new Error('missing tool call')
    assert.deepEqual(terminal.reason, { kind: 'tool-calls' })
    const second = await collect(adapter.stream({ ...options, messages: [...options.messages,
      { role: 'assistant', id: MessageId('fixture-assistant'), source: { kind: 'model', provider: options.provider, model: options.model, replayState: terminal.replayState }, content: [end.block] },
      { role: 'tool', id: MessageId('fixture-result'), source: { kind: 'tool', callId: ToolCallId('fixture-call') }, toolCallId: ToolCallId('fixture-call'), content: [{ type: 'text', text: 'file content' }] },
    ] }))
    assert.deepEqual(second.at(-1)?.type === 'finish' && (second.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason, { kind: 'stop' })
    assert.equal(calls, 2)
  } finally { adapter.dispose(); auth.dispose() }
})

test('quota failures consume one local request and block further attempts for that plan', async () => {
  const auth = new TestAuth()
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => ({ ...defaults, platform: 'zai' }), fetch: async (url) => {
    requests++
    assert.equal(String(url), 'http://127.0.0.1:48101/v1/messages')
    return Response.json({ error: { code: '1308', message: 'fixture quota limit' } }, { status: 429 })
  } })
  try {
    await assert.rejects(collect(adapter.stream({ ...options, provider: 'zcode-zai' })), (error: unknown) =>
      error instanceof LlmError && error.code === 'QUOTA_EXHAUSTED' && /1308/.test(error.message))
    assert.equal((await auth.status('zai')).state, 'quota_exhausted')
    await assert.rejects(adapter.prepareCall('zcode-zai', 'GLM-5.3'), (error: unknown) =>
      error instanceof LlmError && error.code === 'QUOTA_EXHAUSTED')
    assert.equal(requests, 1)
    const policy = adapter.providerRetryPolicy()
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes('QUOTA_EXHAUSTED'), false)
  } finally { adapter.dispose(); auth.dispose() }
})

test('a proxy endpoint outside loopback is rejected before sending a request', async () => {
  class RemoteProxyAuth extends TestAuth {
    override async credential(): Promise<RequestCredential> {
      return { kind: 'proxy', token: 'fixture-local-key', revision: 1,
        url: 'https://example.test/v1/messages' }
    }
  }
  const auth = new RemoteProxyAuth()
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => defaults, fetch: async () => {
    requests++
    return answer({ type: 'text', text: 'unexpected' })
  } })
  try {
    await assert.rejects(collect(adapter.stream(options)), (error: unknown) => error instanceof LlmError && error.code === 'TRANSPORT')
    assert.equal(requests, 0)
  } finally { adapter.dispose(); auth.dispose() }
})

test('prepared calls freeze settings and stop after the account changes', async () => {
  const auth = new TestAuth()
  let settings = { ...defaults }
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => settings, fetch: async (_url, init) => {
    requests++
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 32000)
    return answer({ type: 'text', text: 'ok' })
  } })
  try {
    const controller = new AbortController()
    const prepared = await adapter.prepareCall(options.provider, options.model, controller.signal)
    settings = { ...defaults, maxTokens: 64000 }
    await collect(prepared.stream({ ...options, signal: controller.signal }))
    auth.rotate()
    const chunks = await collect(prepared.stream({ ...options, signal: controller.signal }))
    assert.equal(chunks.at(-1)?.type === 'finish' && (chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason.kind, 'aborted')
    await assert.rejects(adapter.prepareCall(options.provider, options.model, controller.signal))
    assert.equal(requests, 1)
  } finally { adapter.dispose(); auth.dispose() }
})

test('an account change cancels a queued request before it reaches the proxy', async () => {
  const auth = new TestAuth()
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => ({ ...defaults, concurrency: 1 }), fetch: async () => {
    requests++
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"waiting"}}\n\n')) },
    }))
  } })
  const first = adapter.stream(options)
  try {
    await first.next()
    const queued = collect(adapter.stream(options))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(requests, 1)
    auth.rotate()
    const chunks = await queued
    assert.equal(chunks.at(-1)?.type === 'finish' && (chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason.kind, 'aborted')
    assert.equal(requests, 1)
  } finally { await first.return(undefined); adapter.dispose(); auth.dispose() }
})

test('consumer early return cancels the HTTP stream and frees the concurrency slot', async () => {
  const auth = new TestAuth()
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
  try {
    const iterator = adapter.stream(options)
    await iterator.next()
    await iterator.return(undefined)
    assert.equal(cancelled, true)
    await collect(adapter.stream(options))
    assert.equal(requests, 2)
  } finally { adapter.dispose(); auth.dispose() }
})

test('caller cancellation and request timeout terminate the pending local request', async () => {
  for (const scenario of ['cancel', 'timeout'] as const) {
    const auth = new TestAuth()
    const caller = new AbortController()
    let started!: () => void
    const begun = new Promise<void>(resolve => { started = resolve })
    let requests = 0
    const adapter = new ZCodeAdapter({ auth, settings: () => ({ ...defaults, timeoutMs: scenario === 'timeout' ? 30 : 10_000 }),
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        requests++
        started()
        const signal = init?.signal
        if (!signal) throw new Error('missing signal')
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    const keepAlive = setTimeout(() => {}, 1000)
    try {
      const pending = collect(adapter.stream({ ...options, signal: caller.signal }))
      await begun
      if (scenario === 'cancel') {
        caller.abort()
        const chunks = await pending
        assert.equal(chunks.at(-1)?.type === 'finish' && (chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>).reason.kind, 'aborted')
      } else {
        await assert.rejects(pending, (error: unknown) => error instanceof LlmError && error.code === 'TIMEOUT')
      }
      assert.equal(requests, 1)
    } finally { clearTimeout(keepAlive); adapter.dispose(); auth.dispose() }
  }
})

test('an interrupted answer preserves emitted content and does not enter the transient retry budget', async () => {
  const auth = new TestAuth()
  let requests = 0
  const adapter = new ZCodeAdapter({ auth, settings: () => defaults, fetch: async () => {
    requests++
    return stream([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } },
    ])
  } })
  try {
    const content: ContentBlock[] = []
    await assert.rejects((async () => {
      for await (const chunk of adapter.stream(options)) if (chunk.type === 'text-delta') content.push({ type: 'text', text: chunk.text })
    })(), (error: unknown) => error instanceof LlmError && error.code === 'ZCODE_STREAM_INTERRUPTED')
    assert.deepEqual(content, [{ type: 'text', text: 'partial' }])
    assert.equal(requests, 1)
    const policy = adapter.providerRetryPolicy()
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes('ZCODE_STREAM_INTERRUPTED'), false)
  } finally { adapter.dispose(); auth.dispose() }
})

test('session routing isolates profiles, accounts, plans, models, child sessions and purposes', () => {
  const account = { platform: 'bigmodel' as const, scope: 'fixture-scope', generation: 1, mode: 'api-key' as const, signal: new AbortController().signal }
  const request = { ...options, sessionId: 'fixture-session' } as GenerateOptions<string>
  const original = upstreamSession('profile', account, request)
  assert.equal(original, upstreamSession('profile', { ...account, generation: 2 }, request))
  const variants = [
    upstreamSession('profile2', account, request),
    upstreamSession('profile', { ...account, scope: 'another' }, request),
    upstreamSession('profile', { ...account, plan: 'start-plan' }, { ...request, provider: 'zcode-bigmodel-start-plan' }),
    upstreamSession('profile', account, { ...request, model: 'GLM-5.3-Flash' }),
    upstreamSession('profile', account, { ...request, sessionId: 'fixture-child' } as GenerateOptions<string>),
    upstreamSession('profile', account, { ...request, purpose: 'title' } as GenerateOptions<string>),
  ]
  assert.equal(new Set([original, ...variants]).size, 7)
})
