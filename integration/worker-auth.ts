import { randomUUID } from 'node:crypto'
import {
  BigmodelPollOAuthClient,
  LOGIN_TIMEOUT_MS,
  ZaiOAuthClient,
  type OAuthFlowClient,
  type OAuthFlowStart,
} from '../vendor/zcode-api/src/auth/oauth.js'
import { KeyResolver } from '../vendor/zcode-api/src/auth/resolver.js'
import type { Credential } from '../vendor/zcode-api/src/auth/types.js'
import { controlFetch } from './control-fetch.js'

type Platform = Credential['provider']

interface LoginAttempt {
  id: string
  controller: AbortController
  client: OAuthFlowClient
  fetch: typeof fetch
  started?: OAuthFlowStart
  expiresAt: number
  completion?: Promise<Credential>
}

function cancellableSleep(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('LOGIN_CANCELLED'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('LOGIN_CANCELLED'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function scopeFetch(fetcher: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => fetcher(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
  })
}

export class WorkerAuth {
  private attempt: LoginAttempt | null = null

  constructor(private readonly platform: Platform, private readonly fetcher: typeof fetch = controlFetch()) {}

  async resolve(accessToken: string, zcodeToken?: string, userId?: string, fetcher = this.fetcher): Promise<Credential> {
    if (!accessToken) throw new Error('MISSING_ACCESS_TOKEN')
    const credential = await new KeyResolver(fetcher).resolveCodingPlanCredential(accessToken, this.platform, userId)
    return zcodeToken ? { ...credential, jwt: zcodeToken } : credential
  }

  async begin(): Promise<{ attemptId: string; authorizeUrl: string; expiresAt: number }> {
    await this.cancel()
    const controller = new AbortController()
    const scoped = scopeFetch(this.fetcher, controller.signal)
    const attempt = {} as LoginAttempt
    const captureExpiry: typeof fetch = async (input, init) => {
      const response = await scoped(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/oauth/cli/init') && response.ok) {
        const body = await response.clone().json() as { data?: { expires_at?: unknown } }
        if (typeof body.data?.expires_at === 'number') {
          attempt.expiresAt = Math.min(attempt.expiresAt, body.data.expires_at * 1000)
        }
      }
      return response
    }
    const sleep = (ms: number) => cancellableSleep(controller.signal, ms)
    const client = this.platform === 'zai'
      ? new ZaiOAuthClient(captureExpiry, sleep)
      : new BigmodelPollOAuthClient(captureExpiry, sleep)
    Object.assign(attempt, {
      id: randomUUID(), controller, client, fetch: scoped, expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    })
    this.attempt = attempt
    try {
      const started = await client.start()
      this.assertActive(attempt)
      attempt.started = started
      return { attemptId: attempt.id, authorizeUrl: started.authorizeUrl, expiresAt: attempt.expiresAt }
    } catch (error) {
      if (this.attempt === attempt) this.attempt = null
      controller.abort()
      await client.close()
      throw error
    }
  }

  async complete(attemptId: string): Promise<Credential> {
    const attempt = this.attempt
    if (!attempt || attempt.id !== attemptId || !attempt.started) throw new Error('LOGIN_NOT_STARTED')
    attempt.completion ??= this.finish(attempt, attempt.started)
    try {
      return await attempt.completion
    } finally {
      if (this.attempt === attempt) {
        this.attempt = null
        attempt.controller.abort()
        await attempt.client.close()
      }
    }
  }

  async cancel(attemptId?: string): Promise<void> {
    const attempt = this.attempt
    if (!attempt || (attemptId && attempt.id !== attemptId)) return
    this.attempt = null
    attempt.controller.abort()
    await attempt.client.close()
  }

  private async finish(attempt: LoginAttempt, started: OAuthFlowStart): Promise<Credential> {
    const remaining = Math.max(0, attempt.expiresAt - Date.now())
    const tokens = await attempt.client.complete(started, remaining)
    this.assertActive(attempt)
    const credential = await this.resolve(tokens.accessToken, tokens.jwt, tokens.userId, attempt.fetch)
    this.assertActive(attempt)
    return credential
  }

  private assertActive(attempt: LoginAttempt): void {
    if (this.attempt !== attempt || attempt.controller.signal.aborted) throw new Error('LOGIN_CANCELLED')
  }
}
