import { createHash } from 'node:crypto'
import type { AssistantMessage, ContentBlock, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { ProtocolContext } from './types.js'

export interface ReplayBlock {
  fingerprint: string
  signature?: string
}

export function fingerprint(block: ContentBlock): string {
  return createHash('sha256').update(JSON.stringify(block)).digest('hex')
}

export function replayEnvelope(context: ProtocolContext, blocks: ReplayBlock[], responseId?: string): ReplayEnvelope {
  return {
    response: {
      version: 1, provider: context.provider, model: context.model, scope: context.scope,
      ...(responseId ? { responseId } : {}),
    },
    blocks,
  }
}

export function replayBlocks(message: AssistantMessage, context: ProtocolContext): (ReplayBlock | undefined)[] {
  if (message.source.provider !== context.provider || message.source.model !== context.model) return []
  const envelope = message.source.replayState as ReplayEnvelope | undefined
  if (!envelope || typeof envelope !== 'object' || !envelope.response || typeof envelope.response !== 'object') return []
  const response = envelope.response as Record<string, unknown>
  if (response.version !== 1 || response.provider !== context.provider || response.model !== context.model || response.scope !== context.scope) return []
  if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return []
  return envelope.blocks.map((value, index) => {
    if (!value || typeof value !== 'object') return undefined
    const metadata = value as Record<string, unknown>
    if (metadata.fingerprint !== fingerprint(message.content[index])) return undefined
    if (metadata.signature !== undefined && typeof metadata.signature !== 'string') return undefined
    return { fingerprint: metadata.fingerprint as string, ...(typeof metadata.signature === 'string' ? { signature: metadata.signature } : {}) }
  })
}
