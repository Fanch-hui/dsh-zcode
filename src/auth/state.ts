import type { AccountState, AccountStatus, LoginAttempt, Plan, Platform, QuotaSnapshot } from '../types.js'
import type { ProxyEngine, UpstreamCredential } from '../proxy/types.js'
import type { LoginCompletion } from './completion.js'
import { scopeOf, type StoredAccount } from './types.js'

export interface Attempt {
  id: string
  platform: Platform
  workerScope: string
  controller: AbortController
  engine: ProxyEngine
  login?: LoginAttempt
  workerId?: string
  committing: boolean
  committed?: string
  cleanup?: () => void
  completion: LoginCompletion
  previousState: AccountState
  previousError?: string
}

export interface Slot {
  platform: Platform
  generation: number
  state: AccountState
  errorCode?: string
  record?: StoredAccount
  load?: Promise<void>
  loaded: boolean
  controller: AbortController
  revoked?: string
  attempt?: Attempt
  attempts: Map<string, Attempt>
  write: Promise<void>
  migration?: Promise<UpstreamCredential>
  quotas: Map<Plan, { value?: QuotaSnapshot; pending?: Promise<QuotaSnapshot> }>
}

export function newSlot(platform: Platform): Slot {
  return { platform, state: 'signed_out', generation: 0, loaded: false, controller: new AbortController(),
    attempts: new Map(), write: Promise.resolve(), quotas: new Map() }
}

export function identityOf(record: StoredAccount): string {
  return `${record.kind}:${scopeOf(record)}`
}

export function publicStatus(slot: Slot): AccountStatus {
  const record = slot.record
  const status: AccountStatus = { platform: slot.platform, state: slot.state, generation: slot.generation }
  if (record) {
    status.authMode = record.kind === 'grant' ? 'oauth' : 'api-key'
    status.scope = scopeOf(record)
  }
  if (record?.kind === 'grant' && record.payload.accountLabel) status.accountLabel = record.payload.accountLabel
  if (slot.attempt?.login) status.login = slot.attempt.login
  if (slot.errorCode) status.errorCode = slot.errorCode
  return status
}
