import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Plan } from '../types.js'

export type ModelEffort = 'off' | 'low' | 'high' | 'max'

export interface ModelDefinition {
  id: string
  contextWindow: number
  maxTokens: number
  image: boolean
  efforts: readonly ModelEffort[]
  reasoning: 'required' | 'optional' | 'toggle'
}

const models: readonly ModelDefinition[] = [
  { id: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 128000, image: false,
    efforts: ['low', 'high', 'max'], reasoning: 'required' },
  { id: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 128000, image: true,
    efforts: ['low', 'high', 'max'], reasoning: 'required' },
  { id: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 128000, image: false,
    efforts: ['off', 'high', 'max'], reasoning: 'optional' },
  { id: 'GLM-5-Turbo', contextWindow: 200_000, maxTokens: 64000, image: false,
    efforts: ['off', 'high'], reasoning: 'toggle' },
]

const discovered: Record<Plan, readonly string[]> = {
  'coding-plan': ['GLM-5.3', 'GLM-5.3-Flash'],
  // Keep the previously selectable route available for existing sessions.
  'start-plan': ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5.3'],
}

export function modelsForPlan(plan: Plan): readonly string[] { return discovered[plan] }

export function modelDefinition(id: string): ModelDefinition {
  const model = models.find(item => item.id.toLowerCase() === id.toLowerCase())
  if (!model) throw new LlmError('所选模型未列入当前插件目录，请刷新模型目录。', 'MODEL_NOT_FOUND')
  return model
}
