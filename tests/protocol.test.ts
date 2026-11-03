import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildRequest, parseStream, type ProtocolContext } from '../src/protocol/index.js'

const context: ProtocolContext = { provider: 'zcode-bigmodel', model: 'GLM-5.3', scope: 'account-scope' }
const wire = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const text = (value: string) => ({ type: 'text', text: value })

function byteStream(input: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(input)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of parseStream(body, context, signal)) chunks.push(chunk)
  return chunks
}

const streamBody = [
  wire({ type: 'message_start', message: { id: 'msg-fixture', usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 } } }),
  wire({ type: 'content_block_start', index: 8, content_block: { type: 'thinking', thinking: '' } }),
  wire({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call-fixture', name: 'read_file', input: {} } }),
  wire({ type: 'content_block_start', index: 6, content_block: { type: 'text', text: '' } }),
  wire({ type: 'content_block_delta', index: 8, delta: { type: 'thinking_delta', thinking: '先检查' } }),
  wire({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
  wire({ type: 'content_block_delta', index: 6, delta: { type: 'text_delta', text: '你好' } }),
  wire({ type: 'content_block_delta', index: 8, delta: { type: 'signature_delta', signature: 'signature-fixture' } }),
  wire({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"file.txt"}' } }),
  wire({ type: 'content_block_stop', index: 6 }),
  wire({ type: 'content_block_stop', index: 8 }),
  wire({ type: 'content_block_stop', index: 3 }),
  wire({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } }),
  wire({ type: 'message_stop' }),
].join('')

test('decodes fragmented UTF-8, interleaved blocks, tool JSON and cumulative usage', async () => {
  const chunks = await collect(byteStream(streamBody, 2))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start').map(chunk => [chunk.index, chunk.blockType]), [
    [0, 'reasoning'], [1, 'tool-call'], [2, 'text'],
  ])
  const ends = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(ends.map(chunk => chunk.index), [2, 0, 1])
  const call = ends.find(chunk => chunk.index === 1)
  assert.deepEqual(call?.type === 'block-end' && call.block, {
    type: 'tool-call', id: 'call-fixture', name: 'read_file', arguments: '{"path":"file.txt"}',
  })
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: {
    inputTokens: 100, outputTokens: 15, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 145,
  } })
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') throw new Error('missing finish')
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  assert.equal(finish.replayState?.blocks?.length, 3)
})

test('replays a matching signed thought and preserves tool history and reminders', async () => {
  const chunks = await collect(byteStream(streamBody))
  const ends = chunks.filter(chunk => chunk.type === 'block-end').sort((a, b) => a.index - b.index)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') throw new Error('missing finish')
  const assistant = { role: 'assistant', id: 'assistant-fixture',
    source: { kind: 'model', provider: context.provider, model: context.model, replayState: finish.replayState },
    content: ends.map(chunk => chunk.type === 'block-end' && chunk.block) }
  const options = {
    provider: context.provider, model: context.model, system: 'One-shot system.',
    messages: [
      { role: 'system', id: 'system-fixture', source: { kind: 'system-prompt' }, content: [text('Leading system.')] },
      { role: 'user', content: [text('Please read.')] }, assistant,
      { role: 'tool', id: 'result-fixture', source: { kind: 'tool', callId: 'call-fixture' }, toolCallId: 'call-fixture', content: [text('File contents')] },
      { role: 'developer', id: 'dev-fixture', source: { kind: 'user' }, content: [text('Additional rule.')] },
    ],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    stop: ['done'], temperature: 0,
  } as unknown as GenerateOptions<string>
  const request = await buildRequest(options, context)
  assert.equal(request.system, 'One-shot system.\n\nLeading system.')
  assert.equal(request.max_tokens, 32000)
  assert.deepEqual(request.output_config, { effort: 'high' })
  assert.deepEqual(request.stop_sequences, ['done'])
  assert.equal(request.temperature, 0)
  const messages = request.messages as { role: string; content: Record<string, unknown>[] }[]
  assert.equal(messages[1].content[0].signature, 'signature-fixture')
  assert.deepEqual(messages[1].content[1], { type: 'tool_use', id: 'call-fixture', name: 'read_file', input: { path: 'file.txt' } })
  assert.equal(messages[2].content[0].type, 'tool_result')
  assert.match(String(messages[2].content[1].text), /Additional rule/u)
  const switched = await buildRequest(options, { ...context, scope: 'another-account' })
  assert.equal(((switched.messages as typeof messages)[1].content[0]).signature, undefined)
  const edited = structuredClone(options)
  ;(edited.messages[2] as unknown as { content: { text: string }[] }).content[0].text = 'changed'
  const editedRequest = await buildRequest(edited, context)
  assert.equal(((editedRequest.messages as typeof messages)[1].content[0]).signature, undefined)
})

test('multiline SSE data and omitted counters preserve unknown usage fields', async () => {
  const input = [
    'event: message_start\r\ndata: {"message":\r\ndata: {"usage":{"input_tokens":4}}}\r\n\r\n',
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'a' } }),
    wire({ type: 'content_block_stop', index: 0 }),
    wire({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    wire({ type: 'message_stop' }),
  ].join('')
  const chunks = await collect(byteStream(input, 1))
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } })
  const finish = chunks.at(-1)
  assert.deepEqual(finish?.type === 'finish' && finish.reason, { kind: 'stop' })
})

test('rejects incomplete tool arguments without producing a completed tool call', async () => {
  const input = [
    wire({ type: 'message_start', message: {} }),
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} } }),
    wire({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    wire({ type: 'content_block_stop', index: 0 }),
  ].join('')
  const chunks: StreamChunk[] = []
  await assert.rejects(async () => { for await (const chunk of parseStream(byteStream(input), context)) chunks.push(chunk) }, /流事件/u)
  assert.equal(chunks.some(chunk => chunk.type === 'block-end'), false)
})

test('cancels the underlying reader on consumer return and caller abort', async () => {
  let cancelled = 0
  const initial = wire({ type: 'message_start', message: {} }) + wire({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'a' } })
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(initial)) }, cancel() { cancelled++ } })
  const iterator = parseStream(body, context)
  assert.equal((await iterator.next()).value?.type, 'block-start')
  await iterator.return(undefined)
  assert.equal(cancelled, 1)

  let aborted = 0
  const waiting = new ReadableStream<Uint8Array>({ cancel() { aborted++ } })
  const abort = new AbortController()
  const next = parseStream(waiting, context, abort.signal).next()
  abort.abort()
  await assert.rejects(next)
  assert.equal(aborted, 1)
})

test('reports unsupported choices and a stream cut short', async () => {
  const options = { provider: context.provider, model: context.model, messages: [{ role: 'user', content: [text('x')] }], reasoningEffort: 'off' } as unknown as GenerateOptions<string>
  await assert.rejects(() => buildRequest(options, context), (error: { code?: string }) => error.code === 'UNSUPPORTED_OPTION')
  await assert.rejects(() => collect(byteStream(wire({ type: 'message_start', message: {} }))), (error: { code?: string }) => error.code === 'ZCODE_STREAM_INTERRUPTED')
})

test('uses only attachment-service image bytes and retains offloaded placeholders', async () => {
  const imageContext = { ...context, model: 'GLM-5.3-Flash' }
  const attachment = { attachmentId: 'sha256:0123456789abcdef', mediaType: 'image/png', bytes: 3, width: 4, height: 5, name: 'image.png' }
  const options = { provider: imageContext.provider, model: imageContext.model,
    messages: [{ role: 'user', content: [text('inspect'), { type: 'image', attachment }, { type: 'image', attachment, offloaded: true }] }],
  } as unknown as GenerateOptions<string>
  const body = await buildRequest(options, imageContext, async () => 'data:image/png;base64,AQID')
  const content = (body.messages as { content: Record<string, unknown>[] }[])[0].content
  assert.equal(content[0].text, 'inspect')
  assert.match(String(content[1].text), /4x5px/u)
  assert.deepEqual(content[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } })
  assert.match(String(content[3].text), /image omitted/u)
  await assert.rejects(() => buildRequest(options, imageContext, async () => 'https://example.invalid/image.png'),
    (error: { code?: string }) => error.code === 'ZCODE_IMAGE_INVALID')
})

test('merges trailing usage and does not expose upstream error text', async () => {
  const input = [
    wire({ type: 'message_start', message: { usage: { input_tokens: 4 } } }),
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'a' } }),
    wire({ type: 'content_block_stop', index: 0 }),
    wire({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    wire({ type: 'message_stop' }),
    wire({ type: 'message_delta', usage: { output_tokens: 3 } }),
  ].join('')
  const chunks = await collect(byteStream(input))
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 4, outputTokens: 3 } })
  const failure = await collect(byteStream(wire({ type: 'error', error: { type: 'rate_limit_error', message: 'sensitive-upstream-detail' } })))
  assert.equal(failure.length, 1)
  assert.equal(failure[0].type, 'finish')
  assert.doesNotMatch(JSON.stringify(failure), /sensitive-upstream-detail/u)
})

test('a provider error after model output ends with a non-retryable interruption', async () => {
  const input = [
    wire({ type: 'message_start', message: {} }),
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    wire({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
    wire({ type: 'error', error: { type: 'rate_limit_error', message: 'private-detail' } }),
  ].join('')
  const chunks = await collect(byteStream(input))
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('missing error finish')
  assert.equal(finish.reason.failure.code, 'ZCODE_STREAM_INTERRUPTED')
  assert.doesNotMatch(JSON.stringify(chunks), /private-detail/u)
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
})

test('a provider overload after an empty content block remains retryable', async () => {
  for (const block of [{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }]) {
    const input = [
      wire({ type: 'message_start', message: {} }),
      wire({ type: 'content_block_start', index: 0, content_block: block }),
      wire({ type: 'content_block_stop', index: 0 }),
      wire({ type: 'error', error: { type: 'overloaded_error' } }),
    ].join('')
    const chunks = await collect(byteStream(input))
    const finish = chunks.at(-1)
    assert.equal(finish?.type, 'finish')
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('missing error finish')
    assert.equal(finish.reason.failure.code, 'SERVER')
  }
})
