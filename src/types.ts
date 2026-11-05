export type Platform = 'bigmodel' | 'zai'
export type Plan = 'coding-plan' | 'start-plan'
export type AuthMode = 'oauth' | 'api-key'
export type AccountState = 'signed_out' | 'authorizing' | 'ready' | 'reauth_required' | 'quota_exhausted' | 'error'
export interface LoginAttempt { attemptId: string; authorizeUrl: string; expiresAt: number }
export interface AccountStatus {
  platform: Platform
  plan?: Plan
  state: AccountState
  authMode?: AuthMode
  accountLabel?: string
  scope?: string
  generation: number
  login?: LoginAttempt
  errorCode?: string
}
export interface AccountSnapshot {
  platform: Platform
  plan?: Plan
  scope: string
  generation: number
  mode: AuthMode
  signal: AbortSignal
}
export interface RequestCredential {
  token: string
  revision: number
  kind: 'proxy'
  /** Private loopback endpoint owned by the current account snapshot. */
  url: string
}
export interface QuotaWindow {
  name: string
  usedPercent?: number
  remaining?: number
  limit?: number
  resetsAt?: number
  unit?: string
}
export interface QuotaSnapshot { updatedAt: number; windows: QuotaWindow[]; unavailable?: boolean }
/** Model route of one call made through this plugin. */
export interface ModelRoute { provider: string; model: string }
/** Cumulative token counters for one model route or their sum. */
export interface TokenUsageTotals {
  /** All input tokens (cached and uncached) plus output tokens. */
  total: number
  /** Uncached input plus cache reads and cache writes. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Percentage of input tokens served from cache. */
  hitRate: number
}
export interface ModelUsage extends ModelRoute {
  calls: number
  totals: TokenUsageTotals
}
export interface UsageSnapshot {
  /** Sum over every model route, derived from the same counters. */
  totals: TokenUsageTotals
  models: ModelUsage[]
}
export interface AuthPort {
  status(platform: Platform, plan?: Plan): Promise<AccountStatus>
  beginLogin(platform: Platform, signal?: AbortSignal): Promise<AccountStatus>
  waitForLogin(platform: Platform, attemptId: string, signal?: AbortSignal): Promise<void>
  cancelLogin(platform: Platform): Promise<void>
  disconnect(platform: Platform): Promise<void>
  useApiKey(platform: Platform, key: string): Promise<void>
  snapshot(platform: Platform, signal?: AbortSignal, plan?: Plan): Promise<AccountSnapshot>
  credential(snapshot: AccountSnapshot, signal?: AbortSignal): Promise<RequestCredential>
  reject(snapshot: AccountSnapshot, credential: RequestCredential): void
  queryQuota(snapshot: AccountSnapshot, signal?: AbortSignal, force?: boolean): Promise<QuotaSnapshot>
  markState(snapshot: AccountSnapshot, state: 'reauth_required' | 'quota_exhausted', errorCode: string): void
  dispose(): void
}
