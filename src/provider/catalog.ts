import { LlmError, ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Settings } from '../config.js'
import type { Platform } from '../types.js'

export const PROVIDERS = ['zcode-bigmodel', 'zcode-zai'] as const
export const MODELS = ['GLM-5.3', 'GLM-5.3-Flash'] as const

export function platformFor(provider: string): Platform {
  if (provider === 'zcode-bigmodel') return 'bigmodel'
  if (provider === 'zcode-zai') return 'zai'
  throw new LlmError('未知的 ZCode 平台。', 'NO_ADAPTER')
}

export function resolveModel(provider: string, model: string, settings: Settings): LlmResolvedModelInfo {
  platformFor(provider)
  const id = MODELS.find(id => id.toLowerCase() === model.toLowerCase())
  if (!id) throw new LlmError('所选模型未列入当前插件目录，请刷新模型目录。', 'MODEL_NOT_FOUND')
  return {
    provider, id: model, name: id,
    inputModalities: id === 'GLM-5.3-Flash' ? ['text', 'image'] : ['text'],
    context: { contextWindow: 1_000_000 }, defaultMaxTokens: settings.maxTokens,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('low'), name: '低' },
        { id: ReasoningEffortId('high'), name: '高' },
        { id: ReasoningEffortId('max'), name: '最高' },
      ],
      defaultEffort: ReasoningEffortId(settings.effort),
    },
  }
}
