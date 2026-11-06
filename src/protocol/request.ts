import {
  LlmError, offloadedImageText, requestImageHandleText,
  type AssistantMessage, type ContentBlock, type GenerateOptions, type ImageAttachmentAccessResolver,
} from '@deepseek-ai/dsh-llm'
import { replayBlocks } from './replay.js'
import { modelDefinition, type ModelEffort } from '../provider/models.js'
import type { ProtocolContext, ResolveImage, WireObject } from './types.js'

interface WireMessage { role: 'user' | 'assistant'; content: WireObject[] }

function unsupported(message: string, code = 'UNSUPPORTED_CONTENT'): never {
  throw new LlmError(message, code)
}

function toolInput(raw: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return unsupported('历史工具调用参数不是有效的 JSON。', 'INVALID_REQUEST') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unsupported('历史工具调用参数必须是 JSON 对象。', 'INVALID_REQUEST')
  }
  return parsed as Record<string, unknown>
}

function assistantBlocks(message: AssistantMessage, context: ProtocolContext): WireObject[] {
  const replay = replayBlocks(message, context)
  return message.content.flatMap((block, index): WireObject[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
    if (block.type === 'reasoning') {
      const signature = replay[index]?.signature
      return [{ type: 'thinking', thinking: block.text, ...(signature === undefined ? {} : { signature }) }]
    }
    if (block.type === 'tool-call') {
      return [{ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }]
    }
    return unsupported(`不支持的助手内容类型：${block.type}。`)
  })
}

async function inputBlocks(
  blocks: readonly ContentBlock[], image: ResolveImage | undefined, signal?: AbortSignal,
  access?: ImageAttachmentAccessResolver,
): Promise<WireObject[]> {
  const result: WireObject[] = []
  for (const block of blocks) {
    signal?.throwIfAborted()
    if (block.type === 'text') {
      if (block.text) result.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') return unsupported(`不支持的输入内容类型：${block.type}。`)
    if (block.offloaded) {
      result.push({ type: 'text', text: offloadedImageText(block.attachment, access?.(block.attachment)) })
      continue
    }
    if (!image) return unsupported('DSH 图片附件服务未就绪。', 'ZCODE_IMAGE_UNAVAILABLE')
    const dataUrl = await image(block, signal)
    signal?.throwIfAborted()
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(dataUrl)
    if (!match || !match[2] || match[2].length % 4 !== 0) {
      return unsupported('图片附件数据格式无效。', 'ZCODE_IMAGE_INVALID')
    }
    result.push({ type: 'text', text: requestImageHandleText(block.attachment, block.attachment, access?.(block.attachment)) })
    result.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
  }
  return result
}

function append(messages: WireMessage[], role: WireMessage['role'], content: WireObject[]): void {
  if (content.length === 0) return
  const previous = messages.at(-1)
  if (previous?.role === role) previous.content.push(...content)
  else messages.push({ role, content })
}

function textContent(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => {
    if (block.type !== 'text') return unsupported(`不支持的系统内容类型：${block.type}。`)
    return block.text
  }).join('')
}

function validateTools(messages: WireMessage[]): void {
  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pending.size) return unsupported('历史工具调用缺少对应结果。', 'INVALID_REQUEST')
      const calls = message.content.filter(block => block.type === 'tool_use').map(block => String(block.id))
      pending = new Set(calls)
      if (pending.size !== calls.length) return unsupported('历史工具调用 ID 重复。', 'INVALID_REQUEST')
      continue
    }
    const results = message.content.filter(block => block.type === 'tool_result')
    for (const result of results) {
      if (!pending.delete(String(result.tool_use_id))) return unsupported('历史工具结果缺少对应调用。', 'INVALID_REQUEST')
    }
    if (pending.size) return unsupported('历史工具调用缺少对应结果。', 'INVALID_REQUEST')
    message.content = [...results, ...message.content.filter(block => block.type !== 'tool_result')]
  }
  if (pending.size) return unsupported('历史工具调用缺少对应结果。', 'INVALID_REQUEST')
}

export async function buildRequest(
  options: GenerateOptions<string>, context: ProtocolContext, image?: ResolveImage, access?: ImageAttachmentAccessResolver,
): Promise<WireObject> {
  if (options.provider !== context.provider || options.model !== context.model) {
    return unsupported('模型调用上下文已变更。', 'INVALID_REQUEST')
  }
  const model = modelDefinition(options.model)
  const maxTokens = options.maxTokens ?? Math.min(context.defaultMaxTokens ?? 32000, model.maxTokens)
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.maxTokens) {
    return unsupported(`输出上限必须为 1 到 ${model.maxTokens} 的整数。`, 'UNSUPPORTED_OPTION')
  }
  const effort = options.reasoningEffort ?? context.defaultEffort ?? 'high'
  if (!model.efforts.includes(effort as ModelEffort)) {
    return unsupported('所选思考强度不可用。', 'UNSUPPORTED_OPTION')
  }
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)) {
    return unsupported('采样温度必须在 0 到 1 之间。', 'UNSUPPORTED_OPTION')
  }
  if (options.tools?.some(tool => tool.deferLoading)) return unsupported('当前模型不支持延迟加载工具。', 'UNSUPPORTED_OPTION')

  const system: string[] = options.system ? [options.system] : []
  const messages: WireMessage[] = []
  let leading = true
  for (const message of options.messages) {
    options.signal?.throwIfAborted()
    if (message.role === 'system' && leading) {
      const text = textContent(message.content)
      if (text) system.push(text)
      continue
    }
    leading = false
    if (message.role === 'system' || message.role === 'developer') {
      const text = textContent(message.content)
      if (text) append(messages, 'user', [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }])
    } else if (message.role === 'assistant') {
      append(messages, 'assistant', assistantBlocks(message, context))
    } else if (message.role === 'tool') {
      append(messages, 'user', [{ type: 'tool_result', tool_use_id: message.toolCallId,
        content: await inputBlocks(message.content, image, options.signal, access), ...(message.isError ? { is_error: true } : {}) }])
    } else {
      append(messages, 'user', await inputBlocks(message.content, image, options.signal, access))
    }
  }
  if (!messages.length) return unsupported('模型调用缺少消息。', 'INVALID_REQUEST')
  validateTools(messages)
  return {
    model: options.model, max_tokens: maxTokens, messages, stream: true,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...(model.reasoning !== 'toggle' && effort !== 'off' ? { output_config: { effort } } : {}),
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop_sequences: options.stop }),
    ...(options.tools === undefined ? {} : { tools: options.tools.map(tool => ({
      name: tool.name, description: tool.description, input_schema: tool.parameters,
    })) }),
  }
}
