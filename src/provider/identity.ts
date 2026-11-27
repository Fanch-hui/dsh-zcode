import type { Plan, Platform } from '../types.js'
import { t } from '../i18n/index.js'

export const PROVIDER_DEFINITIONS = [
  { id: 'zcode-bigmodel', platform: 'bigmodel', plan: 'coding-plan', name: t('provider.bigmodelCoding') },
  { id: 'zcode-zai', platform: 'zai', plan: 'coding-plan', name: t('provider.zaiCoding') },
  { id: 'zcode-bigmodel-start-plan', platform: 'bigmodel', plan: 'start-plan', name: t('provider.bigmodelStart') },
  { id: 'zcode-zai-start-plan', platform: 'zai', plan: 'start-plan', name: t('provider.zaiStart') },
] as const

export function providerFor(platform: Platform, plan: Plan = 'coding-plan'): string {
  return PROVIDER_DEFINITIONS.find(provider => provider.platform === platform && provider.plan === plan)!.id
}
