import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Plan, Platform } from './types.js'

export interface Settings {
  platform: Platform
  plan?: Plan
  concurrency: number
  maxTokens: number
  timeoutMs: number
  effort: 'low' | 'high' | 'max'
}

export interface Config {
  platform: Volatile<Platform>
  plan: Volatile<Plan>
  concurrency: Volatile<number>
  maxTokens: Volatile<number>
  timeoutMs: Volatile<number>
  effort: Volatile<'low' | 'high' | 'max'>
}

export const Config = z.object({
  platform: z.union(['bigmodel', 'zai']).default('bigmodel').volatile(),
  plan: z.union(['coding-plan', 'start-plan']).default('coding-plan').volatile(),
  concurrency: z.number().step(1).min(1).max(8).default(2).volatile(),
  maxTokens: z.number().step(1).min(1).max(128000).default(32000).volatile(),
  timeoutMs: z.number().step(1000).min(10000).max(1800000).default(300000).volatile(),
  effort: z.union(['low', 'high', 'max']).default('high').volatile(),
})

export function readSettings(config: Config): Settings {
  return {
    platform: config.platform.get(), plan: config.plan.get(), concurrency: config.concurrency.get(),
    maxTokens: config.maxTokens.get(), timeoutMs: config.timeoutMs.get(), effort: config.effort.get(),
  }
}
