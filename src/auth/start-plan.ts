import { createRequire } from 'node:module'
import type { AccountSnapshot, QuotaSnapshot, QuotaWindow, RequestCredential } from '../types.js'
import { AuthError, data, number, object, requestJson, string, waitFor, type Fetcher } from './http.js'

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
const BALANCE_URL = `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(VERSION)}`

interface Entry {
  signal: AbortSignal
  controller: AbortController
  abort(): void
  quota?: QuotaSnapshot
  pending?: Promise<QuotaSnapshot>
}

function amount(value: unknown): number | undefined {
  if (typeof value === 'number') return number(value)
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function moment(value: unknown): number | undefined {
  const seconds = amount(value)
  if (seconds === undefined || seconds <= 0 || seconds > Number.MAX_SAFE_INTEGER / 1000) return undefined
  return Math.trunc(seconds * 1000)
}

function activePlan(plan: Record<string, unknown>, referenceTime: number): boolean {
  if (string(plan.status)?.toLowerCase() !== 'active') return false
  const end = moment(plan.ends_at)
  return end === undefined || end > referenceTime
}

function windowFor(bucket: Record<string, unknown>, plans: Record<string, unknown>[], referenceTime: number): QuotaWindow | undefined {
  const planId = string(bucket.plan_id)
  if (!planId) return undefined
  const ownerId = string(bucket.user_plan_id)
  const owner = plans.find(plan => activePlan(plan, referenceTime) && (
    ownerId && string(plan.user_plan_id) ? string(plan.user_plan_id) === ownerId : string(plan.plan_id) === planId
  ))
  if (!owner) return undefined
  const modelNames = Array.isArray(bucket.capabilities) ? bucket.capabilities
    .map(string).filter((value): value is string => !!value && /^model:/i.test(value))
    .map(value => value.slice(6).trim()).filter(Boolean) : []
  const planName = string(owner.name) ?? 'Start Plan'
  const bucketName = string(bucket.show_name) ?? (modelNames.join(' / ') || '用量')
  const remaining = amount(bucket.remaining_units) ?? amount(bucket.available_units)
  const limit = amount(bucket.total_units)
  const resetsAt = moment(bucket.expires_at)
  const unit = string(bucket.unit_type)
  return {
    name: `${planName} · ${bucketName}`.slice(0, 512),
    ...(remaining !== undefined && remaining >= 0 ? { remaining } : {}),
    ...(limit !== undefined && limit >= 0 ? { limit } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(unit ? { unit: unit.slice(0, 128) } : {}),
  }
}

async function fetchStartQuota(credential: RequestCredential, fetcher: Fetcher,
  now: () => number, signal: AbortSignal): Promise<QuotaSnapshot> {
  if (credential.kind !== 'start-plan' || !credential.deviceId) throw new AuthError('ZCODE_START_LOGIN_REQUIRED')
  const authorization = /^Bearer\s/i.test(credential.token) ? credential.token : `Bearer ${credential.token}`
  let responseTime: number | undefined
  const observed: Fetcher = async (url, init) => {
    const response = await fetcher(url, init)
    const date = Date.parse(response.headers.get('date') ?? '')
    if (Number.isFinite(date)) responseTime = date
    return response
  }
  const raw = await requestJson(observed, BALANCE_URL, {
    method: 'GET', headers: { authorization, 'x-device-mid': credential.deviceId, accept: 'application/json' },
  }, signal)
  const envelope = object(raw)
  if (envelope?.success === false) throw new AuthError('ZCODE_QUOTA_UNAVAILABLE')
  const code = amount(envelope?.code)
  if (code === 1006) throw new AuthError('ZCODE_LOGIN_REQUIRED', 401)
  if (code === 1005) throw new AuthError('ZCODE_START_QUOTA_EXHAUSTED')
  if (code !== undefined && code !== 0 && code !== 200 && Number.isInteger(code) && code >= 1000 && code <= 9999) {
    throw new AuthError(`ZCODE_START_QUOTA_${code}`)
  }
  const payload = object(data(raw))
  if (!Array.isArray(payload?.plans) || !Array.isArray(payload.balances) ||
    payload.plans.length > 128 || payload.balances.length > 128) throw new AuthError('ZCODE_INVALID_RESPONSE')
  const plans = payload.plans.map(object).filter((plan): plan is Record<string, unknown> => !!plan)
  const referenceTime = responseTime ?? moment(payload.server_time) ?? now()
  const windows = payload.balances.map(object).filter((bucket): bucket is Record<string, unknown> => !!bucket)
    .map(bucket => windowFor(bucket, plans, referenceTime)).filter((window): window is QuotaWindow => !!window)
  return { updatedAt: now(), windows }
}

/** One Start Plan quota owner per account generation, shared by all waiters. */
export class StartPlanQuotaCache {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly fetcher: Fetcher, private readonly now: () => number) {}

  async query(snapshot: AccountSnapshot, credential: () => Promise<RequestCredential>,
    checkCurrent: () => Promise<void>, signal?: AbortSignal, force = false): Promise<QuotaSnapshot> {
    signal?.throwIfAborted()
    snapshot.signal.throwIfAborted()
    const entry = this.entryFor(snapshot)
    if (!force && entry.quota && this.now() - entry.quota.updatedAt < 60_000) return entry.quota
    if (!entry.pending) {
      const request = (async () => {
        const currentCredential = await credential()
        entry.controller.signal.throwIfAborted()
        const quota = await fetchStartQuota(currentCredential, this.fetcher, this.now, entry.controller.signal)
        await checkCurrent()
        entry.controller.signal.throwIfAborted()
        entry.quota = quota
        return quota
      })().finally(() => { if (entry.pending === request) entry.pending = undefined })
      entry.pending = request
    }
    const combined = signal ? AbortSignal.any([entry.controller.signal, signal]) : entry.controller.signal
    return waitFor(entry.pending, combined)
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.abort()
    this.entries.clear()
  }

  private entryFor(snapshot: AccountSnapshot): Entry {
    const key = JSON.stringify([snapshot.platform, snapshot.scope, snapshot.generation])
    const previous = this.entries.get(key)
    if (previous && previous.signal === snapshot.signal) return previous
    previous?.abort()
    const controller = new AbortController()
    const entry: Entry = {
      signal: snapshot.signal, controller,
      abort: () => {
        snapshot.signal.removeEventListener('abort', entry.abort)
        controller.abort(snapshot.signal.reason ?? new AuthError('ZCODE_ACCOUNT_CHANGED'))
        if (this.entries.get(key) === entry) this.entries.delete(key)
      },
    }
    this.entries.set(key, entry)
    snapshot.signal.addEventListener('abort', entry.abort, { once: true })
    return entry
  }
}
