import assert from 'node:assert/strict'
import test from 'node:test'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseStream, type ProtocolContext } from '../src/protocol/index.js'
import { startPlanBusinessFailure, startPlanResponseFailure } from '../src/transport/start-plan.js'

const context: ProtocolContext = {
  provider: 'zcode-zai-start-plan', model: 'GLM-5.3', scope: 'fixture-account', plan: 'start-plan',
}
const wire = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

async function collect(input: string): Promise<StreamChunk[]> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(input)); controller.close() },
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of parseStream(body, context)) chunks.push(chunk)
  return chunks
}

test('classifies Start Plan business codes independently of Coding Plan', () => {
  const expected = [
    [1005, 'QUOTA_EXHAUSTED'], [1006, 'AUTH'], [2007, 'SERVER'], [3001, 'INVALID_REQUEST'],
    [3002, 'RATE_LIMIT'], [3006, 'MODEL_NOT_FOUND'], [3007, 'PERMISSION'], [3008, 'RATE_LIMIT'],
    [3009, 'RATE_LIMIT'], [3010, 'RATE_LIMIT'], [3012, 'PERMISSION'], [3999, 'ZCODE_START_PLAN_ERROR'],
  ] as const
  for (const [number, code] of expected) {
    for (const body of [{ code: number, msg: 'fixture-private-detail' }, { error: { code: String(number), message: 'fixture-private-detail' } }]) {
      const failure = startPlanBusinessFailure(body, 200)
      assert.equal(failure?.code, code)
      assert.match(failure?.message ?? '', new RegExp(`平台码 ${number}`))
      assert.doesNotMatch(failure?.message ?? '', /fixture-private-detail/)
      assert.equal(failure?.failure.status, 200)
    }
  }
  assert.equal(startPlanBusinessFailure({ code: 0, data: {} }), undefined)
  assert.equal(startPlanBusinessFailure({ error: { code: 'fixture-private-detail' } }), undefined)
})

test('reads JSON business failures even on HTTP 200 and preserves transient Retry-After', async () => {
  const interactive = await startPlanResponseFailure(Response.json({ error: {
    type: 'captcha_solver_failed', message: 'fixture-private-detail',
  } }, { status: 503 }))
  assert.equal(interactive?.code, 'ZCODE_VERIFICATION_REQUIRED')
  assert.match(interactive?.message ?? '', /安全验证/)
  assert.doesNotMatch(interactive?.message ?? '', /fixture-private-detail/)
  const quota = await startPlanResponseFailure(Response.json({ code: 1005, msg: 'private' }))
  assert.equal(quota?.code, 'QUOTA_EXHAUSTED')
  assert.match(quota?.message ?? '', /1005/)
  assert.equal(quota?.failure.status, 200)

  const verify = await startPlanResponseFailure(Response.json({ code: '3007' }, { status: 403 }))
  assert.equal(verify?.code, 'PERMISSION')
  assert.match(verify?.message ?? '', /安全验证/)
  assert.equal(verify?.failure.status, 403)

  const busy = await startPlanResponseFailure(Response.json({ error: { code: 3008 } }, {
    status: 429, headers: { 'retry-after': '2' },
  }))
  assert.equal(busy?.code, 'RATE_LIMIT')
  assert.equal(busy?.failure.providerRetryAfterMs, 2000)

  const malformed = await startPlanResponseFailure(new Response('fixture-private-detail', { status: 403 }))
  assert.equal(malformed?.code, 'PERMISSION')
  assert.doesNotMatch(malformed?.message ?? '', /fixture-private-detail/)
  const notStream = await startPlanResponseFailure(Response.json({ code: 0, data: {} }))
  assert.equal(notStream?.code, 'ZCODE_INVALID_RESPONSE')
})

test('leaves a successful SSE body available to the stream parser', async () => {
  const response = new Response(wire({ type: 'message_start', message: {} }), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
  assert.equal(await startPlanResponseFailure(response), undefined)
  assert.equal(response.body?.locked, false)
  assert.match(await response.text(), /message_start/)
})

test('maps top-level and nested Start Plan SSE business errors without exposing upstream text', async () => {
  for (const [body, expected] of [
    [{ code: 1005, msg: 'fixture-private-detail' }, 'QUOTA_EXHAUSTED'],
    [{ type: 'error', error: { code: '3007', message: 'fixture-private-detail' } }, 'PERMISSION'],
    [{ type: 'error', error: { code: 3010 } }, 'RATE_LIMIT'],
  ] as const) {
    const chunks = await collect(wire(body))
    assert.equal(chunks.length, 1)
    const finish = chunks[0]
    if (finish.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('missing failure')
    assert.equal(finish.reason.failure.code, expected)
    assert.doesNotMatch(JSON.stringify(chunks), /fixture-private-detail/)
  }
})

test('preserves emitted text and reports interruption when a Start Plan error arrives mid-stream', async () => {
  const chunks = await collect([
    wire({ type: 'message_start', message: {} }),
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial answer' } }),
    wire({ code: 3007, msg: 'fixture-private-detail' }),
  ].join(''))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'partial answer'))
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('missing interruption')
  assert.equal(finish.reason.failure.code, 'ZCODE_STREAM_INTERRUPTED')
  assert.doesNotMatch(JSON.stringify(chunks), /fixture-private-detail/)
})

test('keeps normal Start Plan tool calls and streamed usage intact', async () => {
  const chunks = await collect([
    wire({ type: 'message_start', message: { usage: { input_tokens: 8 } } }),
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-fixture', name: 'read_file', input: {} } }),
    wire({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"notes.txt"}' } }),
    wire({ type: 'content_block_stop', index: 0 }),
    wire({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
    wire({ type: 'message_stop' }),
  ].join(''))
  const block = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(block?.type === 'block-end' && block.block, {
    type: 'tool-call', id: 'call-fixture', name: 'read_file', arguments: '{"path":"notes.txt"}',
  })
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } })
  const finish = chunks.at(-1)
  assert.deepEqual(finish?.type === 'finish' && finish.reason, { kind: 'tool-calls' })
})
