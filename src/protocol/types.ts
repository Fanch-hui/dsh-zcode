import type { ImageBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Plan } from '../types.js'

export interface ProtocolContext {
  provider: string
  model: string
  scope: string
  plan?: Plan
  defaultMaxTokens?: number
  defaultEffort?: ReasoningEffortId
}

/** Resolve a DSH-projected image into a data URL using the attachment service. */
export type ResolveImage = (image: ImageBlock, signal?: AbortSignal) => Promise<string>
export type WireObject = Record<string, unknown>
