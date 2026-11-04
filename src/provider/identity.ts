import type { Plan, Platform } from '../types.js'

export const PROVIDER_DEFINITIONS = [
  { id: 'zcode-bigmodel', platform: 'bigmodel', plan: 'coding-plan', name: 'ZCode · 智谱 Coding Plan' },
  { id: 'zcode-zai', platform: 'zai', plan: 'coding-plan', name: 'ZCode · Z.AI Coding Plan' },
  { id: 'zcode-bigmodel-start-plan', platform: 'bigmodel', plan: 'start-plan', name: 'ZCode · 智谱 Start Plan' },
  { id: 'zcode-zai-start-plan', platform: 'zai', plan: 'start-plan', name: 'ZCode · Z.AI Start Plan' },
] as const

export function providerFor(platform: Platform, plan: Plan = 'coding-plan'): string {
  return PROVIDER_DEFINITIONS.find(provider => provider.platform === platform && provider.plan === plan)!.id
}
