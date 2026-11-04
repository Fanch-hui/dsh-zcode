import { LlmError } from '@deepseek-ai/dsh-llm'
import { retryAfter } from './http.js'
import { readBoundedJson } from './json.js'

interface FailureDescription { code: string; message: string }

const failures: Readonly<Record<string, FailureDescription>> = {
  '1005': { code: 'QUOTA_EXHAUSTED', message: 'Start Plan 当前模型的额度不足，请查看套餐用量。' },
  '1006': { code: 'AUTH', message: 'Start Plan 登录已失效，请重新登录。' },
  '2007': { code: 'SERVER', message: 'Start Plan 服务暂时不可用，请稍后重试。' },
  '3001': { code: 'INVALID_REQUEST', message: 'Start Plan 请求参数无效，请检查接入配置。' },
  '3002': { code: 'RATE_LIMIT', message: 'Start Plan 请求频率受限，请稍后重试。' },
  '3006': { code: 'MODEL_NOT_FOUND', message: 'Start Plan 当前无法使用所选模型。' },
  '3007': { code: 'PERMISSION', message: 'Start Plan 安全验证未通过，请检查平台验证状态。' },
  '3008': { code: 'RATE_LIMIT', message: 'Start Plan 并发请求已达上限，请稍后重试。' },
  '3009': { code: 'RATE_LIMIT', message: 'Start Plan 当前模型并发已达上限，请稍后重试。' },
  '3010': { code: 'RATE_LIMIT', message: 'Start Plan 当前模型并发已达上限，请稍后重试。' },
  '3012': { code: 'PERMISSION', message: 'Start Plan 请求未符合服务端规则，请检查接入配置。' },
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
    return new LlmError('Start Plan 需要在平台完成安全验证，请返回 ZCode 检查验证状态。',
      'ZCODE_VERIFICATION_REQUIRED', status === undefined ? undefined : { status })
  }
  const upstreamCode = businessCode(value)
  if (!upstreamCode) return undefined
  const description = failures[upstreamCode] ?? {
    code: 'ZCODE_START_PLAN_ERROR', message: 'Start Plan 服务返回错误，请检查平台状态。',
  }
  return new LlmError(`${description.message}（平台码 ${upstreamCode}）`, description.code,
    status === undefined ? undefined : { status })
}

function statusFailure(status: number): LlmError {
  if (status === 401) return new LlmError('Start Plan 登录已失效，请重新登录。', 'AUTH', { status })
  if (status === 403) return new LlmError('Start Plan 拒绝访问，请检查套餐和平台验证状态。', 'PERMISSION', { status })
  if (status === 404) return new LlmError('Start Plan 当前无法使用所选模型。', 'MODEL_NOT_FOUND', { status })
  if (status === 429) return new LlmError('Start Plan 请求受限，请稍后重试。', 'RATE_LIMIT', { status })
  if (status >= 500) return new LlmError('Start Plan 服务暂时不可用，请稍后重试。', 'SERVER', { status })
  if (status < 400) return new LlmError('Start Plan 返回的响应格式无效。', 'ZCODE_INVALID_RESPONSE', { status })
  return new LlmError('Start Plan 拒绝了请求，请检查接入配置。', 'INVALID_REQUEST', { status })
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
