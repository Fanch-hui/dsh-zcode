import { LlmError } from '@deepseek-ai/dsh-llm'
import { t } from '../i18n/index.js'
import { retryAfter } from './http.js'
import { readBoundedJson } from './json.js'

interface FailureDescription { code: string; message: string }

function failures(): Readonly<Record<string, FailureDescription>> {
  return {
    '1005': { code: 'QUOTA_EXHAUSTED', message: t('start.c1005') },
    '1006': { code: 'AUTH', message: t('start.c1006') },
    '2007': { code: 'SERVER', message: t('start.c2007') },
    '3001': { code: 'INVALID_REQUEST', message: t('start.c3001') },
    '3002': { code: 'RATE_LIMIT', message: t('start.c3002') },
    '3006': { code: 'MODEL_NOT_FOUND', message: t('start.c3006') },
    '3007': { code: 'PERMISSION', message: t('start.c3007') },
    '3008': { code: 'RATE_LIMIT', message: t('start.c3008') },
    '3009': { code: 'RATE_LIMIT', message: t('start.c3009') },
    '3010': { code: 'RATE_LIMIT', message: t('start.c3010') },
    '3012': { code: 'PERMISSION', message: t('start.c3012') },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function businessCode(value: unknown): string | undefined {
  const root = record(value)
  const raw = root?.code ?? record(root?.error)?.code
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const code = String(raw)
  return /^\d{4}$/.test(code) ? code : undefined
}

export function startPlanBusinessFailure(value: unknown, status?: number): LlmError | undefined {
  const type = record(record(value)?.error)?.type
  if (type === 'captcha_solver_failed' || type === 'captcha_verification_required') {
    return new LlmError(t('start.verificationRequired'),
      'ZCODE_VERIFICATION_REQUIRED', status === undefined ? undefined : { status })
  }
  const upstreamCode = businessCode(value)
  if (!upstreamCode) return undefined
  const description = failures()[upstreamCode] ?? {
    code: 'ZCODE_START_PLAN_ERROR', message: t('start.genericError'),
  }
  return new LlmError(`${description.message}${t('http.detailCode', { code: upstreamCode })}`, description.code,
    status === undefined ? undefined : { status })
}

function statusFailure(status: number): LlmError {
  if (status === 401) return new LlmError(t('start.c1006'), 'AUTH', { status })
  if (status === 403) return new LlmError(t('start.forbidden'), 'PERMISSION', { status })
  if (status === 404) return new LlmError(t('start.c3006'), 'MODEL_NOT_FOUND', { status })
  if (status === 429) return new LlmError(t('start.rateLimited'), 'RATE_LIMIT', { status })
  if (status >= 500) return new LlmError(t('start.c2007'), 'SERVER', { status })
  if (status < 400) return new LlmError(t('start.invalidResponse'), 'ZCODE_INVALID_RESPONSE', { status })
  return new LlmError(t('start.rejected'), 'INVALID_REQUEST', { status })
}

export async function startPlanResponseFailure(response: Response): Promise<LlmError | undefined> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  const json = contentType === 'application/json' || Boolean(contentType?.endsWith('+json'))
  if (response.ok && !json) return undefined

  let body: unknown
  try {
    body = await readBoundedJson(response, 16_384)
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error
  }
  const failure = startPlanBusinessFailure(body, response.status) ?? statusFailure(response.status)
  const delay = retryAfter(response)
  if (!delay || (failure.code !== 'RATE_LIMIT' && failure.code !== 'SERVER')) return failure
  return new LlmError(failure.message, failure.code, { status: response.status, providerRetryAfterMs: delay })
}
