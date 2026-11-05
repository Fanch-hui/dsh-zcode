import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TokenUsageTotals } from './types.js'

const MAX = Number.MAX_SAFE_INTEGER
const add = (current: number, value: number) => Math.min(MAX, current + value)

/** Process-wide totals. DSH reports uncached input separately from cache reads and writes. */
export class TokenUsageTracker {
  private uncachedInput = 0
  private output = 0
  private cacheRead = 0
  private cacheWrite = 0

  record(usage: TokenUsage): void {
    this.uncachedInput = add(this.uncachedInput, usage.inputTokens)
    this.output = add(this.output, usage.outputTokens)
    this.cacheRead = add(this.cacheRead, usage.cacheReadTokens ?? 0)
    this.cacheWrite = add(this.cacheWrite, usage.cacheWriteTokens ?? 0)
  }

  snapshot(): TokenUsageTotals {
    const input = add(add(this.uncachedInput, this.cacheRead), this.cacheWrite)
    return {
      total: add(input, this.output),
      input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite,
      hitRate: input === 0 ? 0 : (this.cacheRead / input) * 100,
    }
  }
}
