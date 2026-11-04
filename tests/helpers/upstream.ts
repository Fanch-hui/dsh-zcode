import type { Plan, Platform } from '../../src/types.js'
import type { ProxyEngine, UpstreamCredential, UpstreamPort } from '../../src/proxy/types.js'
import { waitFor } from '../../src/auth/http.js'

type Handler = (method: string, params: unknown, platform: Platform, scope: string) => unknown | Promise<unknown>

export class FixtureUpstream implements UpstreamPort {
  readonly calls: { method: string; params: unknown; platform: Platform; scope: string }[] = []
  readonly invalidations: Platform[] = []
  private readonly engines = new Map<string, ProxyEngine>()
  constructor(private readonly handler?: Handler) {}

  get(platform: Platform, scope = 'auth'): ProxyEngine {
    const key = `${platform}:${scope}`
    const existing = this.engines.get(key)
    if (existing) return existing
    const call = async <T>(method: string, params?: unknown): Promise<T> => {
      this.calls.push({ method, params, platform, scope })
      const override = await this.handler?.(method, params, platform, scope)
      if (override !== undefined) return override as T
      switch (method) {
        case 'beginLogin': return { attemptId: 'fixture-attempt', authorizeUrl: 'https://chat.z.ai/authorize', expiresAt: Date.now() + 300_000 } as T
        case 'completeLogin': return { provider: platform, apiKey: 'fixture-key', secret: 'fixture-secret', jwt: 'fixture-jwt' } as T
        case 'resolve': return { provider: platform, apiKey: 'fixture-key', jwt: 'fixture-jwt' } as T
        case 'quota': return { balances: [{ showName: 'GLM', remainingUnits: 75, totalUnits: 100 }],
          codingPlan: { limits: [{ type: 'TOKENS_LIMIT', percentage: 25, remaining: 75, total: 100 }] }, errors: [] } as T
        default: return null as T
      }
    }
    const engine: ProxyEngine = {
      apiKey: 'fixture-local-key', rpc: (method, params, signal) => waitFor(call(method, params), signal),
      start: async (plan: Plan, credential: UpstreamCredential) => {
        await call('start', { plan, credential })
        return 'http://127.0.0.1:22334/v1/messages'
      },
      dispose() {},
    }
    this.engines.set(key, engine)
    return engine
  }

  invalidate(platform: Platform): void {
    this.invalidations.push(platform)
    for (const key of this.engines.keys()) if (key.startsWith(`${platform}:`)) this.engines.delete(key)
  }

  release(platform: Platform, scope: string): void {
    this.engines.delete(`${platform}:${scope}`)
  }

  dispose(): void { this.engines.clear() }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
