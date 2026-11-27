import { LlmError } from '@deepseek-ai/dsh-llm'
import { t } from '../i18n/index.js'
import type { AccountSnapshot, AuthPort, RequestCredential } from '../types.js'
import { readBoundedJson } from './json.js'

export function retryAfter(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86_400_000) : undefined
}

function quotaLimits(): Readonly<Record<string, string>> {
  return {
    '1113': t('http.c1113'), '1308': t('http.c1308'), '1310': t('http.c1310'),
    '1316': t('http.c1316'), '1317': t('http.c1317'), '1318': t('http.c1318'),
    '1319': t('http.c1319'), '1320': t('http.c1320'), '1321': t('http.c1321'),
  }
}

function permissionLimits(): Readonly<Record<string, string>> {
  return {
    '1309': t('http.c1309'), '1311': t('http.c1311'), '1313': t('http.c1313'),
    '1314': t('http.c1314'), '1315': t('http.c1315'),
  }
}

function transientLimits(): Readonly<Record<string, string>> {
  return { '1302': t('http.c1302'), '1305': t('http.c1305') }
}

export async function httpFailure(response: Response, account: AccountSnapshot,
  credential: RequestCredential, auth: Pick<AuthPort, 'reject' | 'markState'>, delay?: number): Promise<LlmError> {
  const status = response.status
  if (status === 429) {
    const code = await readProviderCode(response)
    const label = account.platform === 'zai' ? t('platform.zai') : t('platform.bigmodelShort')
    const detail = code ? t('http.detailCode', { code }) : t('http.detailHttp')
    if (code && quotaLimits()[code]) {
      auth.markState(account, 'quota_exhausted', 'QUOTA_EXHAUSTED')
      return new LlmError(t('http.labelMessage', { label, message: `${quotaLimits()[code]}${detail}` }), 'QUOTA_EXHAUSTED', { status })
    }
    if (code && permissionLimits()[code]) {
      return new LlmError(t('http.labelMessage', { label, message: `${permissionLimits()[code]}${detail}` }), 'PERMISSION', { status })
    }
    const message = transientLimits()[code ?? ''] ?? t('http.fallback429')
    return new LlmError(t('http.labelMessage', { label, message: `${message}${detail}` }), code === '1305' ? 'SERVER' : 'RATE_LIMIT', {
      status, ...(delay ? { providerRetryAfterMs: delay } : {}),
    })
  }
  await response.body?.cancel()
  if (status === 401) {
    auth.reject(account, credential)
    return new LlmError(t('http.authExpired'), 'AUTH', { status })
  }
  if (status === 403) return new LlmError(t('http.forbidden'), 'PERMISSION', { status })
  if (status === 402) {
    auth.markState(account, 'quota_exhausted', 'QUOTA_EXHAUSTED')
    return new LlmError(t('http.quotaExhausted'), 'QUOTA_EXHAUSTED', { status })
  }
  if (status === 404) return new LlmError(t('http.modelNotFound'), 'MODEL_NOT_FOUND', { status })
  if (status >= 500) return new LlmError(t('http.serverUnavailable'), 'SERVER', { status })
  return new LlmError(t('http.invalidRequest'), 'INVALID_REQUEST', { status })
}

async function readProviderCode(response: Response): Promise<string | undefined> {
  let body: unknown
  try {
    body = await readBoundedJson(response, 16_384)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return undefined
    throw error
  }
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined
  const error = body.error
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = String(error.code)
  return /^\d{4}$/.test(code) ? code : undefined
}
