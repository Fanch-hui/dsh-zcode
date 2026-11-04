import type { Plan, QuotaSnapshot, QuotaWindow } from '../types.js'
import { AuthError, number, object, string } from './http.js'

function timestamp(value: unknown): number | undefined {
  const date = number(value)
  if (date === undefined || date <= 0) return undefined
  return date < 100_000_000_000 ? date * 1000 : date
}

function balanceWindow(value: unknown): QuotaWindow | undefined {
  const balance = object(value)
  const name = string(balance?.showName)
  if (!name) return undefined
  const remaining = number(balance?.remainingUnits)
  const limit = number(balance?.totalUnits)
  const resetsAt = timestamp(balance?.expiresAt)
  const unit = string(balance?.unitType)
  return {
    name: name.slice(0, 512),
    ...(remaining !== undefined && remaining >= 0 ? { remaining } : {}),
    ...(limit !== undefined && limit >= 0 ? { limit } : {}),
    ...(resetsAt ? { resetsAt } : {}), ...(unit ? { unit: unit.slice(0, 128) } : {}),
  }
}

function codingWindow(value: unknown): QuotaWindow | undefined {
  const item = object(value)
  const type = string(item?.type)
  const names: Record<string, string> = { TOKENS_LIMIT: 'Token', CREDIT_LIMIT: '积分', TIME_LIMIT: '工具调用' }
  const name = type ? names[type] : undefined
  if (!name) return undefined
  const remaining = number(item?.remaining)
  const limit = number(item?.total)
  const usedPercent = number(item?.percentage)
  const resetsAt = timestamp(item?.nextResetTime)
  const unit = string(item?.unit)
  return {
    name, ...(remaining !== undefined && remaining >= 0 ? { remaining } : {}),
    ...(limit !== undefined && limit >= 0 ? { limit } : {}),
    ...(usedPercent !== undefined && usedPercent >= 0 && usedPercent <= 100 ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}), ...(unit ? { unit: unit.slice(0, 128) } : {}),
  }
}

export function projectQuota(value: unknown, plan: Plan, now: number): QuotaSnapshot {
  const result = object(value)
  if (!result) throw new AuthError('ZCODE_QUOTA_UNAVAILABLE')
  if (plan === 'start-plan') {
    const errors = Array.isArray(result.errors) ? result.errors : []
    if (!Array.isArray(result.balances) || errors.some(error => typeof error === 'string' && error.startsWith('balance:'))) {
      throw new AuthError('ZCODE_QUOTA_UNAVAILABLE')
    }
    return { updatedAt: now, windows: result.balances.map(balanceWindow).filter((window): window is QuotaWindow => !!window) }
  }
  const coding = object(result.codingPlan)
  if (!Array.isArray(coding?.limits)) throw new AuthError('ZCODE_QUOTA_UNAVAILABLE')
  return { updatedAt: now, windows: coding.limits.map(codingWindow).filter((window): window is QuotaWindow => !!window) }
}
