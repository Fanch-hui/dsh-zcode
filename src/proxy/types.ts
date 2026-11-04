import type { Plan, Platform } from '../types.js'

/** Private upstream data. Never part of the browser RPC schema. */
export interface UpstreamCredential {
  provider: Platform
  apiKey: string
  secret?: string
  jwt?: string
  oauthAccessToken?: string
  expiresAt?: number
  userId?: string
}

export interface ProxyEngine {
  readonly apiKey: string
  rpc<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>
  start(plan: Plan, credential: UpstreamCredential, signal?: AbortSignal): Promise<string>
  dispose(): void
}

export interface UpstreamPort {
  get(platform: Platform, scope?: string): ProxyEngine
  release(platform: Platform, scope: string): void
  invalidate(platform: Platform): void
  dispose(): void
}
