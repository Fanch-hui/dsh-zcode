import { LlmError } from '@deepseek-ai/dsh-llm'
import type { WireObject } from './types.js'

const MAX_EVENT_CHARS = 8 * 1024 * 1024

interface EventFrame { name?: string; data: string[]; size: number }

function decodeEvent(frame: EventFrame): WireObject | undefined {
  if (frame.data.length === 0) return undefined
  const data = frame.data.join('\n')
  if (data === '[DONE]') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { throw new LlmError('模型流事件格式无效。', 'ZCODE_INVALID_STREAM') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmError('模型流事件格式无效。', 'ZCODE_INVALID_STREAM')
  }
  const value = parsed as WireObject
  return typeof value.type === 'string' || !frame.name ? value : { ...value, type: frame.name }
}

/** Decode UTF-8 incrementally and dispatch complete SSE data fields. */
export async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<WireObject> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frame: EventFrame = { data: [], size: 0 }
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      buffer += decoder.decode(next.value, { stream: !next.done })
      if (buffer.length + frame.size > MAX_EVENT_CHARS) throw new LlmError('模型流事件过大。', 'ZCODE_INVALID_STREAM')
      while (true) {
        const newline = buffer.search(/[\r\n]/u)
        if (newline < 0 || (!next.done && buffer[newline] === '\r' && newline === buffer.length - 1)) break
        const line = buffer.slice(0, newline)
        const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1
        buffer = buffer.slice(newline + width)
        if (!line) {
          const event = decodeEvent(frame)
          frame = { data: [], size: 0 }
          if (event) yield event
          continue
        }
        if (line.startsWith(':')) continue
        const separator = line.indexOf(':')
        const field = separator < 0 ? line : line.slice(0, separator)
        let value = separator < 0 ? '' : line.slice(separator + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') { frame.data.push(value); frame.size += value.length }
        else if (field === 'event') frame.name = value
        if (frame.size + buffer.length > MAX_EVENT_CHARS) throw new LlmError('模型流事件过大。', 'ZCODE_INVALID_STREAM')
      }
      if (!next.done) continue
      if (buffer.startsWith('data:')) {
        const value = buffer.slice(5)
        frame.data.push(value.startsWith(' ') ? value.slice(1) : value)
      }
      const event = decodeEvent(frame)
      if (event) yield event
      return
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
