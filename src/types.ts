export type Platform = 'bigmodel' | 'zai'
export type AuthMode = 'oauth' | 'api-key'
export type AccountState = 'signed_out' | 'authorizing' | 'ready' | 'reauth_required' | 'quota_exhausted' | 'error'
export interface LoginAttempt { attemptId: string; authorizeUrl: string; expiresAt: number }
export interface AccountStatus {
  platform: Platform
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
  scope: string
  generation: number
  mode: AuthMode
  signal: AbortSignal
}
export interface RequestCredential { token: string; revision: number; kind: 'pat' | 'api-key' }
export interface QuotaWindow {
  name: string
  usedPercent?: number
  remaining?: number
  limit?: number
  resetsAt?: number
  unit?: string
}
export interface QuotaSnapshot { updatedAt: number; windows: QuotaWindow[]; unavailable?: boolean }
export interface AuthPort {
  status(platform: Platform): Promise<AccountStatus>
  beginLogin(platform: Platform, signal?: AbortSignal): Promise<AccountStatus>
  waitForLogin(platform: Platform, attemptId: string, signal?: AbortSignal): Promise<void>
  cancelLogin(platform: Platform): Promise<void>
  disconnect(platform: Platform): Promise<void>
  useApiKey(platform: Platform, key: string): Promise<void>
  snapshot(platform: Platform, signal?: AbortSignal): Promise<AccountSnapshot>
  credential(snapshot: AccountSnapshot, signal?: AbortSignal): Promise<RequestCredential>
  reject(snapshot: AccountSnapshot, credential: RequestCredential): void
  queryQuota(snapshot: AccountSnapshot, signal?: AbortSignal, force?: boolean): Promise<QuotaSnapshot>
  markState(snapshot: AccountSnapshot, state: 'reauth_required' | 'quota_exhausted', errorCode: string): void
  dispose(): void
}
