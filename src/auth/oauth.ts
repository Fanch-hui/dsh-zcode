import { randomBytes } from 'node:crypto'
import type { LoginAttempt, Platform } from '../types.js'
import { AuthError, data, delay, number, object, requestJson, string, type Fetcher } from './http.js'

const OAUTH_BASE = 'https://zcode.z.ai/api/v1/oauth/cli'
export interface OAuthInit { attempt: LoginAttempt; flowId: string; pollToken: string; intervalMs: number }
export interface OAuthGrant { accessToken: string; zcodeToken: string; userId: string; accountLabel?: string }

function authorizeUrl(value: unknown, platform: Platform): string {
  const raw = string(value)
  if (!raw) throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE')
  let url: URL
  try { url = new URL(raw) } catch { throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE') }
  const host = url.hostname.toLowerCase()
  const validHost = host === 'zcode.z.ai' || (platform === 'bigmodel'
    ? host === 'bigmodel.cn' || host === 'open.bigmodel.cn'
    : host === 'chat.z.ai')
  if (url.protocol !== 'https:' || !validHost || url.username || url.password || url.port) {
    throw new AuthError('ZCODE_OAUTH_INVALID_URL')
  }
  return url.href
}

export async function initOAuth(platform: Platform, attemptId: string, fetcher: Fetcher, now: () => number, signal: AbortSignal): Promise<OAuthInit> {
  const pollToken = randomBytes(32).toString('hex')
  const response = await requestJson(fetcher, `${OAUTH_BASE}/init`, {
    method: 'POST', headers: { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: platform }),
  }, signal)
  const value = object(data(response))
  const flowId = string(value?.flow_id)
  const expiresAt = (number(value?.expires_at) ?? 0) * 1000
  const intervalMs = (number(value?.poll_interval_sec) ?? 0) * 1000
  if (!flowId || expiresAt <= now() || intervalMs < 1000 || intervalMs >= expiresAt - now()) {
    throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE')
  }
  return { attempt: { attemptId, authorizeUrl: authorizeUrl(value?.authorize_url, platform), expiresAt }, flowId, pollToken, intervalMs }
}

export async function pollOAuth(platform: Platform, init: OAuthInit, fetcher: Fetcher, now: () => number, signal: AbortSignal): Promise<OAuthGrant> {
  while (now() < init.attempt.expiresAt) {
    signal.throwIfAborted()
    const raw = await requestJson(fetcher, `${OAUTH_BASE}/poll/${encodeURIComponent(init.flowId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${init.pollToken}` },
    }, signal)
    const value = object(data(raw))
    if (value?.status === 'failed') throw new AuthError('ZCODE_OAUTH_REJECTED')
    if (value?.status === 'ready') {
      const user = object(value.user)
      const provider = object(value[platform])
      const accessToken = string(provider?.access_token) ?? string(provider?.accessToken)
      const zcodeToken = string(value.token)
      const userId = string(user?.user_id)
      if (!accessToken || !zcodeToken || !userId) throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE')
      const accountLabel = string(user?.name)
      return { accessToken, zcodeToken, userId, ...(accountLabel ? { accountLabel } : {}) }
    }
    if (value?.status !== 'pending') throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE')
    const remaining = init.attempt.expiresAt - now()
    if (remaining <= 0) break
    await delay(Math.min(init.intervalMs, remaining), signal)
  }
  throw new AuthError('ZCODE_OAUTH_EXPIRED')
}
