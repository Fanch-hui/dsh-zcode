import type { ImageBlock } from '@deepseek-ai/dsh-llm'

export interface ProtocolContext {
  provider: string
  model: string
  scope: string
  defaultMaxTokens?: number
  defaultEffort?: 'low' | 'high' | 'max'
}

/** Resolve a DSH-projected image into a data URL using the attachment service. */
export type ResolveImage = (image: ImageBlock, signal?: AbortSignal) => Promise<string>
export type WireObject = Record<string, unknown>
