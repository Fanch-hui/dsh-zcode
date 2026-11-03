import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { fingerprint, replayEnvelope, type ReplayBlock } from './replay.js'
import { readEvents } from './sse.js'
import type { ProtocolContext, WireObject } from './types.js'

type GeneratedBlock = Extract<ContentBlock, { type: 'text' | 'reasoning' | 'tool-call' }>
interface BlockState {
  index: number
  content: GeneratedBlock
  closed: boolean
  partialJson: string
  signature?: string
}
type Counts = Partial<TokenUsage>

function invalid(): never { throw new LlmError('模型返回的流事件不完整或格式无效。', 'ZCODE_INVALID_STREAM') }
function object(value: unknown): WireObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as WireObject
}
function string(value: unknown): string { if (typeof value !== 'string') return invalid(); return value }
function blockIndex(event: WireObject): number {
  if (!Number.isSafeInteger(event.index) || Number(event.index) < 0) return invalid()
  return Number(event.index)
}

function updateUsage(counts: Counts, value: unknown): void {
  const usage = object(value)
  const fields = {
    input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadTokens',
    cache_creation_input_tokens: 'cacheWriteTokens', reasoning_tokens: 'reasoningTokens', total_tokens: 'totalTokens',
  } as const
  for (const [wire, local] of Object.entries(fields)) {
    const number = usage[wire]
    if (number === undefined || number === null) continue
    if (!Number.isSafeInteger(number) || Number(number) < 0) return invalid()
    counts[local] = Number(number)
  }
}

function finalUsage(counts: Counts): TokenUsage | undefined {
  if (counts.inputTokens === undefined || counts.outputTokens === undefined) return undefined
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = counts
  const knownSum = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  let total: number | undefined
  if (Number.isSafeInteger(knownSum)) {
    if (totalTokens !== undefined && totalTokens >= knownSum) total = totalTokens
    else if (totalTokens === undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined) total = knownSum
  }
  return {
    inputTokens, outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

function startBlock(event: WireObject, index: number): BlockState {
  const raw = object(event.content_block)
  if (raw.type === 'text') return { index, content: { type: 'text', text: string(raw.text) }, closed: false, partialJson: '' }
  if (raw.type === 'thinking') return {
    index, content: { type: 'reasoning', text: string(raw.thinking) }, closed: false, partialJson: '',
    ...(raw.signature === undefined ? {} : { signature: string(raw.signature) }),
  }
  if (raw.type !== 'tool_use') return invalid()
  const id = string(raw.id)
  const name = string(raw.name)
  if (!id || !name) return invalid()
  const initial = raw.input === undefined ? {} : object(raw.input)
  return { index, content: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(initial) }, closed: false, partialJson: '' }
}

function delta(block: BlockState, value: unknown): StreamChunk | undefined {
  const change = object(value)
  if (change.type === 'text_delta' && block.content.type === 'text') {
    const text = string(change.text)
    block.content.text += text
    return { type: 'text-delta', index: block.index, text }
  }
  if (change.type === 'thinking_delta' && block.content.type === 'reasoning') {
    const text = string(change.thinking)
    block.content.text += text
    return { type: 'reasoning-delta', index: block.index, text }
  }
  if (change.type === 'signature_delta' && block.content.type === 'reasoning') {
    block.signature = (block.signature ?? '') + string(change.signature)
    return undefined
  }
  if (change.type === 'input_json_delta' && block.content.type === 'tool-call') {
    const argumentsDelta = string(change.partial_json)
    block.partialJson += argumentsDelta
    return { type: 'tool-call-delta', index: block.index, id: block.content.id, argumentsDelta }
  }
  return invalid()
}

function close(block: BlockState): StreamChunk[] {
  const events: StreamChunk[] = []
  if (block.content.type === 'tool-call') {
    if (block.partialJson) block.content.arguments = block.partialJson
    let value: unknown
    try { value = JSON.parse(block.content.arguments) } catch { return invalid() }
    object(value)
    if (!block.partialJson) events.push({ type: 'tool-call-delta', index: block.index, id: block.content.id, argumentsDelta: block.content.arguments })
  }
  block.closed = true
  events.push({ type: 'block-end', index: block.index, block: { ...block.content } })
  return events
}

function stopReason(value: unknown): FinishReason {
  if (value === 'end_turn' || value === 'stop_sequence') return { kind: 'stop' }
  if (value === 'tool_use') return { kind: 'tool-calls' }
  if (value === 'max_tokens') return { kind: 'max-tokens' }
  return invalid()
}

function inBandError(event: WireObject, observed: boolean): FinishReason {
  if (observed) return { kind: 'error', failure: { code: 'ZCODE_STREAM_INTERRUPTED', message: '模型输出中断，请重试。' } }
  const type = object(event.error).type
  const codes: Record<string, string> = {
    authentication_error: 'AUTH', permission_error: 'PERMISSION', rate_limit_error: 'RATE_LIMIT',
    invalid_request_error: 'INVALID_REQUEST', api_error: 'SERVER', overloaded_error: 'SERVER',
  }
  const code = typeof type === 'string' ? codes[type] ?? 'ZCODE_STREAM_ERROR' : 'ZCODE_STREAM_ERROR'
  return { kind: 'error', failure: { code, message: '模型服务返回错误，请检查连接后重试。' } }
}

/** Translate Anthropic Messages SSE into DSH chunks with lossless native replay metadata. */
export async function* parseStream(
  body: ReadableStream<Uint8Array>, context: ProtocolContext, signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, BlockState>()
  const counts: Counts = {}
  let started = false
  let stopped = false
  let observed = false
  let responseId: string | undefined
  let reason: FinishReason | undefined
  for await (const event of readEvents(body, signal)) {
    signal?.throwIfAborted()
    if (event.type === 'ping') continue
    if (event.type === 'error') {
      yield { type: 'finish', reason: inBandError(event, observed) }
      return
    }
    if (event.type === 'message_start') {
      if (started) return invalid()
      const message = object(event.message)
      if (message.id !== undefined) responseId = string(message.id)
      if (message.usage !== undefined) updateUsage(counts, message.usage)
      started = true
      continue
    }
    if (!started) return invalid()
    if (event.type === 'message_delta') {
      const change = event.delta === undefined ? {} : object(event.delta)
      if (change.stop_reason !== undefined && change.stop_reason !== null) {
        if (stopped) return invalid()
        reason = stopReason(change.stop_reason)
      }
      if (event.usage !== undefined) updateUsage(counts, event.usage)
      continue
    }
    if (event.type === 'message_stop') {
      if (stopped || !reason || [...blocks.values()].some(block => !block.closed)) return invalid()
      stopped = true
      continue
    }
    if (stopped || reason) return invalid()
    if (event.type === 'content_block_start') {
      const nativeIndex = blockIndex(event)
      if (blocks.has(nativeIndex)) return invalid()
      const block = startBlock(event, blocks.size)
      blocks.set(nativeIndex, block)
      yield { type: 'block-start', index: block.index, blockType: block.content.type }
      if (block.content.type === 'tool-call') {
        observed = true
        yield { type: 'tool-call-delta', index: block.index, id: block.content.id, name: block.content.name, argumentsDelta: '' }
      } else if (block.content.text) {
        observed = true
        yield { type: block.content.type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: block.content.text }
      }
      continue
    }
    if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      const block = blocks.get(blockIndex(event))
      if (!block || block.closed) return invalid()
      if (event.type === 'content_block_stop') yield* close(block)
      else {
        const change = delta(block, event.delta)
        if (change) {
          if ((change.type === 'text-delta' || change.type === 'reasoning-delta') && change.text) observed = true
          yield change
        }
      }
    }
  }
  signal?.throwIfAborted()
  if (!stopped || !reason) throw new LlmError('模型流在结束前断开，请重试。', 'ZCODE_STREAM_INTERRUPTED')
  const usage = finalUsage(counts)
  if (usage) yield { type: 'usage', usage }
  const metadata: ReplayBlock[] = [...blocks.values()].map(block => ({
    fingerprint: fingerprint(block.content), ...(block.signature === undefined ? {} : { signature: block.signature }),
  }))
  yield { type: 'finish', reason, replayState: replayEnvelope(context, metadata, responseId) }
}
