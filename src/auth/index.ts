import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AccountSnapshot, AccountState, AccountStatus, AuthPort, LoginAttempt, Platform, QuotaSnapshot, RequestCredential } from '../types.js'
import { AuthError, waitFor, type Fetcher } from './http.js'
import { initOAuth, pollOAuth, type OAuthInit } from './oauth.js'
import { PatManager } from './pat.js'
import { fetchQuota } from './quota.js'
import { LoginCompletion } from './completion.js'
import { readAccount, scopeOf, type CredentialStore, type KeyLocation, type StoredAccount, type StoredGrant } from './types.js'

export type { CredentialStore, KeyLocation, StoredAccount, StoredGrant } from './types.js'
export { AuthError } from './http.js'

interface Attempt {
  id: string
  controller: AbortController
  init?: OAuthInit
  committing: boolean
  committed?: string
  cleanup?: () => void
  completion: LoginCompletion
  previousState: AccountState
  previousError?: string
}
interface Slot {
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
  pat?: PatManager
  quota?: QuotaSnapshot
  quotaPending?: Promise<QuotaSnapshot>
}

export interface AuthOptions {
  store: CredentialStore
  fetch?: Fetcher
  now?: () => number
  random?: () => number
  onChange?: (status: AccountStatus) => void
}

function newSlot(platform: Platform): Slot {
  return { platform, state: 'signed_out', generation: 0, loaded: false, controller: new AbortController(), attempts: new Map(), write: Promise.resolve() }
}

function identityOf(record: StoredAccount): string {
  return `${record.kind}:${scopeOf(record)}`
}

export class ZcodeAuth implements AuthPort {
  private readonly slots = new Map<Platform, Slot>([['bigmodel', newSlot('bigmodel')], ['zai', newSlot('zai')]])
  private readonly fetcher: Fetcher
  private readonly now: () => number
  private readonly random: () => number
  private disposed = false

  constructor(private readonly options: AuthOptions) {
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  private async ensure(platform: Platform): Promise<Slot> {
    if (this.disposed) throw new AuthError('ZCODE_DISPOSED')
    const slot = this.slots.get(platform)
    if (!slot) throw new AuthError('ZCODE_INVALID_PLATFORM')
    if (!slot.loaded && !slot.load) {
      slot.load = this.options.store.load(platform).then(value => {
        try {
          slot.record = readAccount(value, platform)
          slot.state = slot.record ? 'ready' : 'signed_out'
        } catch (error) {
          if (!(error instanceof AuthError) || error.code !== 'ZCODE_CREDENTIAL_INVALID') throw error
          slot.state = 'error'
          slot.errorCode = error.code
        }
        slot.loaded = true
      }).catch(() => {
        slot.state = 'error'
        slot.errorCode = 'ZCODE_CREDENTIAL_STORE_ERROR'
        throw new AuthError('ZCODE_CREDENTIAL_STORE_ERROR')
      }).finally(() => { slot.load = undefined })
    }
    if (slot.load) await slot.load
    return slot
  }

  private publicStatus(slot: Slot): AccountStatus {
    const record = slot.record
    const login: LoginAttempt | undefined = slot.attempt?.init?.attempt
    const status: AccountStatus = {
      platform: slot.platform, state: slot.state, generation: slot.generation,
    }
    if (record) {
      status.authMode = record.kind === 'grant' ? 'oauth' : 'api-key'
      status.scope = scopeOf(record)
    }
    if (record?.kind === 'grant' && record.payload.accountLabel) status.accountLabel = record.payload.accountLabel
    if (login) status.login = login
    if (slot.errorCode) status.errorCode = slot.errorCode
    return status
  }

  private changed(slot: Slot): void {
    try { this.options.onChange?.(this.publicStatus(slot)) } catch { /* observer failures cannot veto state */ }
  }

  private serial<T>(slot: Slot, task: () => Promise<T>): Promise<T> {
    const result = slot.write.then(task)
    slot.write = result.then(() => undefined, () => undefined)
    return result
  }

  private settleAttempt(attempt: Attempt, errorCode?: string): void {
    attempt.cleanup?.()
    attempt.cleanup = undefined
    attempt.init = undefined
    attempt.completion.settle(errorCode)
  }

  private cancelAttempt(slot: Slot): void {
    const attempt = slot.attempt
    if (attempt && !attempt.committing) {
      attempt.controller.abort()
      slot.attempt = undefined
      this.settleAttempt(attempt, 'ZCODE_OAUTH_CANCELLED')
    }
  }

  private restoreCancelledLogin(slot: Slot, attempt: Attempt): void {
    if (slot.record && slot.revoked === identityOf(slot.record)) {
      slot.state = 'error'
      slot.errorCode = 'ZCODE_DISCONNECT_FAILED'
      return
    }
    slot.state = attempt.previousState
    slot.errorCode = attempt.previousError
  }

  private failedLoginState(slot: Slot, attempt: Attempt): AccountState {
    if (!slot.record || slot.revoked === identityOf(slot.record)) return 'error'
    return attempt.previousState === 'reauth_required' ? 'reauth_required' : 'ready'
  }

  private clearActive(slot: Slot): void {
    slot.controller.abort(new AuthError('ZCODE_ACCOUNT_CHANGED'))
    slot.controller = new AbortController()
    slot.generation++
    slot.pat = undefined
    slot.quota = undefined
    slot.quotaPending = undefined
  }

  private assertAttempt(slot: Slot, attempt: Attempt): void {
    if (this.disposed || slot.attempt !== attempt || attempt.controller.signal.aborted) throw new AuthError('ZCODE_OAUTH_CANCELLED')
  }

  private assertSnapshot(slot: Slot, snapshot: AccountSnapshot): void {
    if (this.disposed || !slot.record || snapshot.signal.aborted || snapshot.platform !== slot.platform ||
      snapshot.generation !== slot.generation || snapshot.scope !== scopeOf(slot.record) ||
      snapshot.mode !== (slot.record.kind === 'grant' ? 'oauth' : 'api-key') ||
      slot.revoked === identityOf(slot.record)) throw new AuthError('ZCODE_ACCOUNT_CHANGED')
  }

  async reconcile(platform: Platform): Promise<void> {
    const slot = await this.ensure(platform)
    await this.serial(slot, async () => {
      let next: StoredAccount | undefined
      let invalid = false
      try { next = readAccount(await this.options.store.load(platform), platform) }
      catch (error) {
        if (error instanceof AuthError && error.code === 'ZCODE_CREDENTIAL_INVALID') invalid = true
        else throw new AuthError('ZCODE_CREDENTIAL_STORE_ERROR')
      }
      const previous = slot.record
      const sameIdentity = previous?.kind === next?.kind &&
        (!previous || !next || scopeOf(previous) === scopeOf(next))
      if (sameIdentity && !invalid) {
        slot.record = next
        return
      }
      if (sameIdentity && invalid && slot.state === 'error' && slot.errorCode === 'ZCODE_CREDENTIAL_INVALID') return
      this.cancelAttempt(slot)
      this.clearActive(slot)
      slot.record = next
      slot.revoked = undefined
      slot.state = next ? 'ready' : 'signed_out'
      if (invalid) slot.state = 'error'
      slot.errorCode = invalid ? 'ZCODE_CREDENTIAL_INVALID' : undefined
      this.changed(slot)
    })
  }

  async status(platform: Platform): Promise<AccountStatus> {
    const slot = await this.ensure(platform)
    await this.reconcile(platform)
    return this.publicStatus(slot)
  }

  async beginLogin(platform: Platform, signal?: AbortSignal): Promise<AccountStatus> {
    signal?.throwIfAborted()
    const slot = await this.ensure(platform)
    await waitFor(this.reconcile(platform), signal)
    signal?.throwIfAborted()
    const previousState = slot.attempt?.previousState ?? slot.state
    const previousError = slot.attempt?.previousError ?? slot.errorCode
    this.cancelAttempt(slot)
    if (slot.attempt) throw new AuthError('ZCODE_OAUTH_COMMITTING')
    const attempt: Attempt = { id: randomUUID(), controller: new AbortController(), committing: false, completion: new LoginCompletion(), previousState, previousError }
    slot.attempt = attempt
    slot.attempts.set(attempt.id, attempt)
    for (const [id, previous] of slot.attempts) {
      if (slot.attempts.size <= 32) break
      if (previous.completion.finished) slot.attempts.delete(id)
    }
    if (signal) {
      const cancel = () => {
        if (slot.attempt !== attempt || attempt.committing) return
        this.cancelAttempt(slot)
        this.restoreCancelledLogin(slot, attempt)
        this.changed(slot)
      }
      signal.addEventListener('abort', cancel, { once: true })
      attempt.cleanup = () => signal.removeEventListener('abort', cancel)
    }
    slot.state = 'authorizing'
    slot.errorCode = undefined
    this.changed(slot)
    try {
      const init = await initOAuth(platform, attempt.id, this.fetcher, this.now, attempt.controller.signal)
      this.assertAttempt(slot, attempt)
      attempt.init = init
      this.changed(slot)
      void this.finishLogin(slot, attempt, init)
      return this.publicStatus(slot)
    } catch (error) {
      this.settleAttempt(attempt, error instanceof AuthError ? error.code : 'ZCODE_OAUTH_FAILED')
      if (slot.attempt === attempt) {
        slot.attempt = undefined
        slot.state = this.failedLoginState(slot, attempt)
        slot.errorCode = error instanceof AuthError ? error.code : 'ZCODE_OAUTH_FAILED'
        this.changed(slot)
      }
      throw error
    }
  }

  private async finishLogin(slot: Slot, attempt: Attempt, init: OAuthInit): Promise<void> {
    try {
      const grant = await pollOAuth(slot.platform, init, this.fetcher, this.now, attempt.controller.signal)
      this.assertAttempt(slot, attempt)
      const identity = createHash('sha256').update(`zcode\0${slot.platform}\0${grant.userId}`).digest('hex')
      const scope = `${identity}.${randomBytes(16).toString('hex')}`
      const account: StoredGrant = { kind: 'grant', payload: {
        schemaVersion: 1, platform: slot.platform, scope, oauthAccessToken: grant.accessToken, zcodeToken: grant.zcodeToken,
        ...(grant.accountLabel ? { accountLabel: grant.accountLabel.slice(0, 120) } : {}),
      } }
      await this.serial(slot, async () => {
        this.assertAttempt(slot, attempt)
        attempt.committing = true
        try { await this.options.store.save(slot.platform, account, () => this.assertAttempt(slot, attempt), slot.record) }
        finally { attempt.committing = false }
        attempt.committed = scopeOf(account)
        this.clearActive(slot)
        slot.record = account
        slot.revoked = undefined
        slot.attempt = undefined
        slot.state = 'ready'
        slot.errorCode = undefined
        this.changed(slot)
        this.settleAttempt(attempt)
      })
      void this.snapshot(slot.platform).then(snapshot => this.credential(snapshot)).catch(error => {
        if (slot.record === account && error instanceof AuthError) {
          slot.errorCode = error.code
          this.changed(slot)
        }
      })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'ZCODE_ACCOUNT_CHANGED') {
        try { await this.reconcile(slot.platform) }
        catch {
          slot.state = 'error'
          slot.errorCode = 'ZCODE_CREDENTIAL_STORE_ERROR'
          this.changed(slot)
        } finally { this.settleAttempt(attempt, error.code) }
        return
      }
      this.settleAttempt(attempt, error instanceof AuthError ? error.code : 'ZCODE_OAUTH_FAILED')
      if (slot.attempt !== attempt) return
      slot.attempt = undefined
      slot.state = this.failedLoginState(slot, attempt)
      slot.errorCode = error instanceof AuthError ? error.code : 'ZCODE_OAUTH_FAILED'
      this.changed(slot)
    }
  }

  async waitForLogin(platform: Platform, attemptId: string, signal?: AbortSignal): Promise<void> {
    const slot = await this.ensure(platform)
    const attempt = slot.attempts.get(attemptId)
    if (!attempt) throw new AuthError('ZCODE_OAUTH_ATTEMPT_EXPIRED')
    await attempt.completion.wait(signal, () => attempt.committing)
  }

  async cancelLogin(platform: Platform): Promise<void> {
    const slot = await this.ensure(platform)
    const attempt = slot.attempt
    this.cancelAttempt(slot)
    await slot.write
    if (attempt && !attempt.committed && !slot.attempt) {
      this.restoreCancelledLogin(slot, attempt)
      this.changed(slot)
    }
  }

  async useApiKey(platform: Platform, key: string): Promise<void> {
    const value = key.trim()
    if (value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) throw new AuthError('ZCODE_INVALID_API_KEY')
    const slot = await this.ensure(platform)
    await this.reconcile(platform)
    this.cancelAttempt(slot)
    const account: StoredAccount = { kind: 'api-key', key: value, env: { DSH_ZCODE_SCOPE: randomBytes(24).toString('hex') } }
    try {
      await this.serial(slot, async () => {
        await this.options.store.save(platform, account, () => { if (this.disposed) throw new AuthError('ZCODE_DISPOSED') }, slot.record)
        this.clearActive(slot)
        slot.record = account
        slot.revoked = undefined
        slot.state = 'ready'
        slot.errorCode = undefined
        this.changed(slot)
      })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'ZCODE_ACCOUNT_CHANGED') await this.reconcile(platform)
      throw error
    }
  }

  async disconnect(platform: Platform): Promise<void> {
    const slot = await this.ensure(platform)
    const expectedAtClick = slot.record
    const committingAttempt = slot.attempt?.committing ? slot.attempt : undefined
    this.cancelAttempt(slot)
    this.clearActive(slot)
    slot.revoked = expectedAtClick ? identityOf(expectedAtClick) : undefined
    slot.state = 'error'
    slot.errorCode = 'ZCODE_DISCONNECT_PENDING'
    this.changed(slot)
    try {
      await this.serial(slot, async () => {
        let expected = expectedAtClick
        if (committingAttempt?.committed && slot.record && scopeOf(slot.record) === committingAttempt.committed) expected = slot.record
        this.clearActive(slot)
        slot.revoked = expected ? identityOf(expected) : undefined
        try {
          await this.options.store.remove(platform, () => { if (this.disposed) throw new AuthError('ZCODE_DISPOSED') }, expected)
        } catch (error) {
          if (error instanceof AuthError && error.code === 'ZCODE_ACCOUNT_CHANGED') throw error
          slot.errorCode = 'ZCODE_DISCONNECT_FAILED'
          this.changed(slot)
          throw new AuthError('ZCODE_DISCONNECT_FAILED')
        }
        slot.record = undefined
        slot.revoked = undefined
        slot.state = 'signed_out'
        slot.errorCode = undefined
        this.changed(slot)
      })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'ZCODE_ACCOUNT_CHANGED') await this.reconcile(platform)
      throw error
    }
  }

  async snapshot(platform: Platform, signal?: AbortSignal): Promise<AccountSnapshot> {
    signal?.throwIfAborted()
    const slot = await this.ensure(platform)
    await waitFor(this.reconcile(platform), signal)
    signal?.throwIfAborted()
    const record = slot.record
    if (!record || slot.state === 'reauth_required' || slot.revoked === identityOf(record)) throw new AuthError('ZCODE_LOGIN_REQUIRED')
    return { platform, scope: scopeOf(record), generation: slot.generation,
      mode: record.kind === 'grant' ? 'oauth' : 'api-key', signal: slot.controller.signal }
  }

  async credential(snapshot: AccountSnapshot, signal?: AbortSignal): Promise<RequestCredential> {
    const slot = await this.ensure(snapshot.platform)
    await waitFor(this.reconcile(snapshot.platform), signal)
    this.assertSnapshot(slot, snapshot)
    signal?.throwIfAborted()
    const record = slot.record!
    if (record.kind === 'api-key') return { token: record.key, kind: 'api-key', revision: slot.generation }
    if (!slot.pat) slot.pat = new PatManager({
      platform: slot.platform, grant: record, fetch: this.fetcher, now: this.now, random: this.random,
      signal: slot.controller.signal, check: () => this.assertSnapshot(slot, snapshot),
      setLocation: location => this.setLocation(slot, snapshot, location),
    })
    try {
      const result = await slot.pat.resolve(signal)
      await waitFor(this.reconcile(snapshot.platform), signal)
      this.assertSnapshot(slot, snapshot)
      return result
    }
    catch (error) {
      signal?.throwIfAborted()
      await this.reconcile(snapshot.platform)
      this.assertSnapshot(slot, snapshot)
      if (error instanceof AuthError && error.status === 401) this.markState(snapshot, 'reauth_required', 'ZCODE_LOGIN_REQUIRED')
      throw error
    }
  }

  private async setLocation(slot: Slot, snapshot: AccountSnapshot, location: KeyLocation | undefined): Promise<void> {
    try {
      await this.serial(slot, async () => {
        this.assertSnapshot(slot, snapshot)
        if (slot.record?.kind !== 'grant') throw new AuthError('ZCODE_ACCOUNT_CHANGED')
        const expected = slot.record
        const payload = { ...expected.payload }
        if (location) payload.location = location
        else delete payload.location
        const updated: StoredGrant = { kind: 'grant', payload }
        await this.options.store.save(slot.platform, updated, () => this.assertSnapshot(slot, snapshot), expected)
        this.assertSnapshot(slot, snapshot)
        slot.record = updated
      })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'ZCODE_ACCOUNT_CHANGED') await this.reconcile(slot.platform)
      throw error
    }
  }

  reject(snapshot: AccountSnapshot, credential: RequestCredential): void {
    const slot = this.slots.get(snapshot.platform)
    if (!slot) return
    try { this.assertSnapshot(slot, snapshot) } catch { return }
    if (credential.kind === 'pat') slot.pat?.invalidate(credential)
    else if (credential.revision === slot.generation) this.markState(snapshot, 'reauth_required', 'ZCODE_API_KEY_REJECTED')
  }

  async queryQuota(snapshot: AccountSnapshot, signal?: AbortSignal, force = false): Promise<QuotaSnapshot> {
    const slot = await this.ensure(snapshot.platform)
    await waitFor(this.reconcile(snapshot.platform), signal)
    this.assertSnapshot(slot, snapshot)
    if (!force && slot.quota && this.now() - slot.quota.updatedAt < 60_000) return slot.quota
    if (!slot.quotaPending) {
      const request = (async () => {
        const credential = await this.credential(snapshot)
        const quota = await fetchQuota(snapshot.platform, credential.token, this.fetcher, this.now, snapshot.signal)
        await this.reconcile(snapshot.platform)
        this.assertSnapshot(slot, snapshot)
        slot.quota = quota
        const measured = quota.windows.filter(window => (window.name.startsWith('Token · ') || window.name.startsWith('积分 · ')) &&
          (window.remaining !== undefined || window.usedPercent !== undefined))
        const exhausted = measured.some(window => window.remaining === 0 || window.usedPercent === 100)
        if (exhausted) {
          slot.state = 'quota_exhausted'
          slot.errorCode = 'ZCODE_QUOTA_EXHAUSTED'
          this.changed(slot)
        } else if (slot.state === 'quota_exhausted' && measured.length > 0) {
          slot.state = 'ready'
          slot.errorCode = undefined
          this.changed(slot)
        }
        return quota
      })().finally(() => { if (slot.quotaPending === request) slot.quotaPending = undefined })
      slot.quotaPending = request
    }
    const quota = await waitFor(slot.quotaPending, signal)
    this.assertSnapshot(slot, snapshot)
    return quota
  }

  markState(snapshot: AccountSnapshot, state: 'reauth_required' | 'quota_exhausted', errorCode: string): void {
    const slot = this.slots.get(snapshot.platform)
    if (!slot) return
    try { this.assertSnapshot(slot, snapshot) } catch { return }
    slot.state = state
    slot.errorCode = errorCode
    this.changed(slot)
  }

  dispose(): void {
    this.disposed = true
    for (const slot of this.slots.values()) {
      const attempt = slot.attempt
      attempt?.cleanup?.()
      attempt?.controller.abort()
      if (attempt && !attempt.committing) {
        this.settleAttempt(attempt, 'ZCODE_DISPOSED')
        slot.attempt = undefined
      }
      slot.controller.abort()
      slot.pat = undefined
      slot.quota = undefined
      slot.quotaPending = undefined
    }
  }
}
