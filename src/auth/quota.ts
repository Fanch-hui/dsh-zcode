import type { Platform, QuotaSnapshot, QuotaWindow } from '../types.js'
import { AuthError, number, object, requestJson, string, type Fetcher } from './http.js'

const ENDPOINTS: Record<Platform, string> = {
  bigmodel: 'https://bigmodel.cn/api/monitor/usage/quota/limit',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
}

function windowFrom(raw: unknown): QuotaWindow | undefined {
  const value = object(raw)
  const type = string(value?.type)
  const unit = number(value?.unit)
  const duration = number(value?.number)
  let period: string | undefined
  if (unit === 3 && duration === 5) period = '5 小时'
  else if (unit === 6) period = '每周'
  let name: string | undefined
  if (period && type === 'TOKENS_LIMIT') name = `Token · ${period}`
  if (period && type === 'CREDIT_LIMIT') name = `积分 · ${period}`
  if (type === 'TIME_LIMIT' && unit === 5 && duration === 1) name = '工具调用'
  if (!name) return undefined
  const percentage = number(value?.percentage)
  const remaining = number(value?.remaining)
  const limit = number(value?.usage)
  const resetsAt = number(value?.nextResetTime)
  return {
    name,
    ...(percentage !== undefined && percentage >= 0 && percentage <= 100 ? { usedPercent: percentage } : {}),
    ...(remaining !== undefined && remaining >= 0 ? { remaining } : {}),
    ...(limit !== undefined && limit >= 0 ? { limit } : {}),
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
  }
}

export async function fetchQuota(platform: Platform, token: string, fetcher: Fetcher, now: () => number, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const result = object(await requestJson(fetcher, ENDPOINTS[platform], { method: 'GET', headers: { authorization: token } }, signal))
  if (!result || result.success === false || (result.code !== undefined && ![0, 200, '0', '200'].includes(result.code as string | number))) {
    throw new AuthError('ZCODE_QUOTA_UNAVAILABLE')
  }
  const payload = object(result.data)
  if (!Array.isArray(payload?.limits)) throw new AuthError('ZCODE_INVALID_RESPONSE')
  const windows = payload.limits.map(windowFrom).filter((value): value is QuotaWindow => value !== undefined)
  return { updatedAt: now(), windows }
}
