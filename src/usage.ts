import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ModelRoute, ModelUsage, TokenUsageTotals, UsageSnapshot } from './types.js'

const MAX = Number.MAX_SAFE_INTEGER
const add = (current: number, value: number) => Math.min(MAX, current + value)

interface Counters extends ModelRoute {
  calls: number
  uncachedInput: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function empty(route: ModelRoute): Counters {
  return { ...route, calls: 0, uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function totals(counters: Counters): TokenUsageTotals {
  const input = add(add(counters.uncachedInput, counters.cacheRead), counters.cacheWrite)
  return {
    total: add(input, counters.output),
    input, output: counters.output, cacheRead: counters.cacheRead, cacheWrite: counters.cacheWrite,
    hitRate: input === 0 ? 0 : (counters.cacheRead / input) * 100,
  }
}

/** Per-provider/model totals for calls made through this plugin. The overall sum is derived, never stored twice. */
export class TokenUsageTracker {
  private readonly models = new Map<string, Counters>()

  record(route: ModelRoute, usage: TokenUsage): void {
    const key = `${route.provider}\u0000${route.model}`
    let entry = this.models.get(key)
    if (!entry) {
      entry = empty(route)
      this.models.set(key, entry)
    }
    entry.calls = add(entry.calls, 1)
    entry.uncachedInput = add(entry.uncachedInput, usage.inputTokens)
    entry.output = add(entry.output, usage.outputTokens)
    entry.cacheRead = add(entry.cacheRead, usage.cacheReadTokens ?? 0)
    entry.cacheWrite = add(entry.cacheWrite, usage.cacheWriteTokens ?? 0)
  }

  snapshot(): UsageSnapshot {
    const sum = empty({ provider: '', model: '' })
    const models: ModelUsage[] = []
    for (const entry of this.models.values()) {
      models.push({ provider: entry.provider, model: entry.model, calls: entry.calls, totals: totals(entry) })
      sum.calls = add(sum.calls, entry.calls)
      sum.uncachedInput = add(sum.uncachedInput, entry.uncachedInput)
      sum.output = add(sum.output, entry.output)
      sum.cacheRead = add(sum.cacheRead, entry.cacheRead)
      sum.cacheWrite = add(sum.cacheWrite, entry.cacheWrite)
    }
    return { totals: totals(sum), models }
  }
}
