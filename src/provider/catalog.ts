import { LlmError, ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Settings } from '../config.js'
import type { Plan, Platform } from '../types.js'
import { PROVIDER_DEFINITIONS } from './identity.js'
import { modelDefinition, modelsForPlan } from './models.js'

export { providerFor } from './identity.js'
export const PROVIDERS = PROVIDER_DEFINITIONS.map(provider => provider.id)
const effortNames = { off: '关闭', low: '低', high: '高', max: '最高' }

function providerDefinition(provider: string) {
  const found = PROVIDER_DEFINITIONS.find(entry => entry.id === provider)
  if (!found) throw new LlmError('未知的 ZCode 平台。', 'NO_ADAPTER')
  return found
}

export function platformFor(provider: string): Platform { return providerDefinition(provider).platform }
export function planFor(provider: string): Plan { return providerDefinition(provider).plan }
export function providerName(provider: string): string { return providerDefinition(provider).name }
export function modelsForProvider(provider: string): readonly string[] { return modelsForPlan(planFor(provider)) }

export function resolveModel(provider: string, model: string, settings: Settings): LlmResolvedModelInfo {
  platformFor(provider)
  const info = modelDefinition(model)
  const defaultEffort = info.efforts.includes(settings.effort) ? settings.effort : 'high'
  return {
    provider, id: model, name: info.id,
    inputModalities: info.image ? ['text', 'image'] : ['text'],
    context: { contextWindow: info.contextWindow }, defaultMaxTokens: Math.min(settings.maxTokens, info.maxTokens),
    reasoning: {
      efforts: info.efforts.map(effort => ({ id: ReasoningEffortId(effort),
        name: info.reasoning === 'toggle' && effort === 'high' ? '开启' : effortNames[effort] })),
      defaultEffort: ReasoningEffortId(defaultEffort),
    },
  }
}
