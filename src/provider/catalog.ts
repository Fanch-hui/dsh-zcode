import { LlmError, ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { t } from '../i18n/index.js'
import type { Settings } from '../config.js'
import type { Plan, Platform } from '../types.js'
import { PROVIDER_DEFINITIONS } from './identity.js'
import { modelDefinition, modelsForPlan } from './models.js'

export { providerFor } from './identity.js'
export const PROVIDERS = PROVIDER_DEFINITIONS.map(provider => provider.id)

function providerDefinition(provider: string) {
  const found = PROVIDER_DEFINITIONS.find(entry => entry.id === provider)
  if (!found) throw new LlmError(t('catalog.unknownPlatform'), 'NO_ADAPTER')
  return found
}

export function platformFor(provider: string): Platform { return providerDefinition(provider).platform }
export function planFor(provider: string): Plan { return providerDefinition(provider).plan }
export function providerName(provider: string): string { return providerDefinition(provider).name }
export function modelsForProvider(provider: string): readonly string[] { return modelsForPlan(planFor(provider)) }

export function resolveModel(provider: string, model: string, settings: Settings): LlmResolvedModelInfo {
  platformFor(provider)
  const effortNames = { off: t('effort.off'), low: t('effort.low'), high: t('effort.high'), max: t('effort.max') }
  const info = modelDefinition(model)
  const defaultEffort = info.efforts.includes(settings.effort) ? settings.effort : 'high'
  return {
    provider, id: model, name: info.id,
    inputModalities: info.image ? ['text', 'image'] : ['text'],
    context: { contextWindow: info.contextWindow }, defaultMaxTokens: Math.min(settings.maxTokens, info.maxTokens),
    reasoning: {
      efforts: info.efforts.map(effort => ({ id: ReasoningEffortId(effort),
        name: info.reasoning === 'toggle' && effort === 'high' ? t('effort.on') : effortNames[effort] })),
      defaultEffort: ReasoningEffortId(defaultEffort),
    },
  }
}
