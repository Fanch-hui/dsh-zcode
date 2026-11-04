import { randomBytes, randomUUID } from 'node:crypto'
import type { AccountSnapshot, AccountState, AccountStatus, AuthPort, LoginAttempt, Plan, Platform, QuotaSnapshot, RequestCredential } from '../types.js'
import type { UpstreamCredential, UpstreamPort } from '../proxy/types.js'
import { AuthError, waitFor } from './http.js'
import { projectQuota } from './quota.js'
import { LoginCompletion, validateLogin } from './completion.js'
import { readAccount, scopeOf, type CredentialStore, type StoredAccount, type StoredGrant } from './types.js'
import { identityOf, newSlot, publicStatus, type Attempt, type Slot } from './state.js'

export type { CredentialStore, KeyLocation, StoredAccount, StoredGrant } from './types.js'
export { AuthError } from './http.js'

export interface AuthOptions {
  store: CredentialStore
  upstream: UpstreamPort
  now?: () => number
  onChange?: (status: AccountStatus) => void
}

export class ZcodeAuth implements AuthPort {
  private readonly slots = new Map<Platform, Slot>([['bigmodel', newSlot('bigmodel')], ['zai', newSlot('zai')]])
  private readonly now: () => number
  private disposed = false

  constructor(private readonly options: AuthOptions) {
    this.now = options.now ?? Date.now
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

  private changed(slot: Slot): void {
    try { this.options.onChange?.(publicStatus(slot)) } catch { /* observer failures cannot veto state */ }
  }

  private serial<T>(slot: Slot, task: () => Promise<T>): Promise<T> {
    const result = slot.write.then(task)
    slot.write = result.then(() => undefined, () => undefined)
    return result
  }

  private settleAttempt(attempt: Attempt, errorCode?: string): void {
    attempt.cleanup?.()
    attempt.cleanup = undefined
    attempt.login = undefined
    attempt.completion.settle(errorCode)
    this.options.upstream.release(attempt.platform, attempt.workerScope)
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
    slot.migration = undefined
    slot.quotas.clear()
    this.options.upstream.invalidate(slot.platform)
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

  async status(platform: Platform, plan?: Plan): Promise<AccountStatus> {
    const slot = await this.ensure(platform)
    await this.reconcile(platform)
    const status = publicStatus(slot)
    if (plan !== 'start-plan') return status
    status.plan = plan
    if (slot.record?.kind === 'grant' && status.state === 'quota_exhausted') {
      status.state = 'ready'
      delete status.errorCode
    }
    if (slot.record?.kind === 'api-key' && ['ready', 'quota_exhausted', 'reauth_required'].includes(status.state)) {
      status.state = 'reauth_required'
      status.errorCode = 'ZCODE_START_LOGIN_REQUIRED'
    }
    return status
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
    const id = randomUUID()
    const workerScope = `auth:${id}`
    const attempt: Attempt = { id, platform, workerScope, controller: new AbortController(), engine: this.options.upstream.get(platform, workerScope),
      committing: false, completion: new LoginCompletion(), previousState, previousError }
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
      const init = await attempt.engine.rpc<LoginAttempt>('beginLogin', undefined, attempt.controller.signal)
      this.assertAttempt(slot, attempt)
      const login = validateLogin(init, platform, this.now())
      attempt.workerId = login.attemptId
      attempt.login = { ...login, attemptId: attempt.id }
      this.changed(slot)
      void this.finishLogin(slot, attempt)
      return publicStatus(slot)
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

  private async finishLogin(slot: Slot, attempt: Attempt): Promise<void> {
    try {
      const grant = await attempt.engine.rpc<UpstreamCredential>('completeLogin', { attemptId: attempt.workerId }, attempt.controller.signal)
      this.assertAttempt(slot, attempt)
      if (grant.provider !== slot.platform || !grant.apiKey) throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE')
      const scope = randomBytes(24).toString('hex')
      const account: StoredGrant = { kind: 'grant', payload: {
        schemaVersion: 1, platform: slot.platform, scope, upstream: grant,
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

  async snapshot(platform: Platform, signal?: AbortSignal, plan?: Plan): Promise<AccountSnapshot> {
    signal?.throwIfAborted()
    const slot = await this.ensure(platform)
    await waitFor(this.reconcile(platform), signal)
    signal?.throwIfAborted()
    const record = slot.record
    if (!record || slot.state === 'reauth_required' || slot.revoked === identityOf(record)) throw new AuthError('ZCODE_LOGIN_REQUIRED')
    if (plan === 'start-plan' && record.kind !== 'grant') throw new AuthError('ZCODE_START_LOGIN_REQUIRED')
    return { platform, scope: scopeOf(record), generation: slot.generation,
      mode: record.kind === 'grant' ? 'oauth' : 'api-key', signal: slot.controller.signal,
      ...(plan === 'start-plan' ? { plan } : {}) }
  }

  async credential(snapshot: AccountSnapshot, signal?: AbortSignal): Promise<RequestCredential> {
    const slot = await this.ensure(snapshot.platform)
    const credential = await this.upstreamCredential(slot, snapshot, signal)
    const plan = snapshot.plan ?? 'coding-plan'
    const engine = this.options.upstream.get(snapshot.platform, `${snapshot.scope}:${plan}`)
    const url = await waitFor(engine.start(plan, credential, snapshot.signal), signal)
    await waitFor(this.reconcile(snapshot.platform), signal)
    this.assertSnapshot(slot, snapshot)
    return { token: engine.apiKey, kind: 'proxy', url, revision: slot.generation }
  }

  private async upstreamCredential(slot: Slot, snapshot: AccountSnapshot, signal?: AbortSignal): Promise<UpstreamCredential> {
    await waitFor(this.reconcile(snapshot.platform), signal)
    this.assertSnapshot(slot, snapshot)
    const record = slot.record!
    if (record.kind === 'api-key') {
      if (snapshot.plan === 'start-plan') throw new AuthError('ZCODE_START_LOGIN_REQUIRED')
      const dot = record.key.indexOf('.')
      return dot > 0 && dot < record.key.length - 1
        ? { provider: slot.platform, apiKey: record.key.slice(0, dot), secret: record.key.slice(dot + 1) }
        : { provider: slot.platform, apiKey: record.key }
    }
    if (record.payload.upstream) return this.checkPlanCredential(record.payload.upstream, snapshot)
    if (!record.payload.oauthAccessToken || !record.payload.zcodeToken) throw new AuthError('ZCODE_CREDENTIAL_INVALID')
    if (!slot.migration) {
      const task = this.migrateGrant(slot, snapshot, record).finally(() => {
        if (slot.migration === task) slot.migration = undefined
      })
      slot.migration = task
    }
    const credential = await waitFor(slot.migration, signal)
    this.assertSnapshot(slot, snapshot)
    return this.checkPlanCredential(credential, snapshot)
  }

  private checkPlanCredential(credential: UpstreamCredential, snapshot: AccountSnapshot): UpstreamCredential {
    if (snapshot.plan === 'start-plan' && !credential.jwt) throw new AuthError('ZCODE_START_LOGIN_REQUIRED')
    return credential
  }

  private async migrateGrant(slot: Slot, snapshot: AccountSnapshot, record: StoredGrant): Promise<UpstreamCredential> {
    const engine = this.options.upstream.get(slot.platform, 'auth')
    const credential = await engine.rpc<UpstreamCredential>('resolve', {
      accessToken: record.payload.oauthAccessToken, zcodeToken: record.payload.zcodeToken,
    }, snapshot.signal)
    if (credential.provider !== slot.platform || !credential.apiKey) throw new AuthError('ZCODE_CREDENTIAL_INVALID')
    await this.reconcile(slot.platform)
    this.assertSnapshot(slot, snapshot)
    try {
      await this.serial(slot, async () => {
        this.assertSnapshot(slot, snapshot)
        if (slot.record?.kind !== 'grant') throw new AuthError('ZCODE_ACCOUNT_CHANGED')
        const expected = slot.record
        const updated: StoredGrant = { kind: 'grant', payload: { ...expected.payload, upstream: credential } }
        await this.options.store.save(slot.platform, updated, () => this.assertSnapshot(slot, snapshot), expected)
        this.assertSnapshot(slot, snapshot)
        slot.record = updated
      })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'ZCODE_ACCOUNT_CHANGED') await this.reconcile(slot.platform)
      throw error
    }
    return credential
  }

  reject(snapshot: AccountSnapshot, credential: RequestCredential): void {
    const slot = this.slots.get(snapshot.platform)
    if (!slot) return
    try { this.assertSnapshot(slot, snapshot) } catch { return }
    if (credential.revision === slot.generation) {
      this.markState(snapshot, 'reauth_required', snapshot.mode === 'oauth' ? 'ZCODE_LOGIN_REQUIRED' : 'ZCODE_API_KEY_REJECTED')
    }
  }

  async queryQuota(snapshot: AccountSnapshot, signal?: AbortSignal, force = false): Promise<QuotaSnapshot> {
    const slot = await this.ensure(snapshot.platform)
    await waitFor(this.reconcile(snapshot.platform), signal)
    this.assertSnapshot(slot, snapshot)
    const plan = snapshot.plan ?? 'coding-plan'
    let entry = slot.quotas.get(plan)
    if (!entry) { entry = {}; slot.quotas.set(plan, entry) }
    if (!force && entry.value && this.now() - entry.value.updatedAt < 60_000) return entry.value
    if (!entry.pending) {
      const owner = entry
      const task = (async () => {
        const credential = await this.upstreamCredential(slot, snapshot, snapshot.signal)
        const engine = this.options.upstream.get(snapshot.platform, `${snapshot.scope}:${plan}`)
        const raw = await engine.rpc<unknown>('quota', { credential, plan }, snapshot.signal)
        const quota = projectQuota(raw, plan, this.now())
        await this.reconcile(snapshot.platform)
        this.assertSnapshot(slot, snapshot)
        owner.value = quota
        if (plan === 'coding-plan') this.applyQuotaState(slot, quota)
        return quota
      })().finally(() => { if (owner.pending === task) owner.pending = undefined })
      entry.pending = task
    }
    const quota = await waitFor(entry.pending, signal)
    this.assertSnapshot(slot, snapshot)
    return quota
  }

  private applyQuotaState(slot: Slot, quota: QuotaSnapshot): void {
    const measured = quota.windows.filter(window => (window.name === 'Token' || window.name === '积分') &&
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
  }

  markState(snapshot: AccountSnapshot, state: 'reauth_required' | 'quota_exhausted', errorCode: string): void {
    const slot = this.slots.get(snapshot.platform)
    if (!slot) return
    try { this.assertSnapshot(slot, snapshot) } catch { return }
    if (snapshot.plan === 'start-plan' && state === 'quota_exhausted') return
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
      slot.migration = undefined
      slot.quotas.clear()
      this.options.upstream.invalidate(slot.platform)
    }
  }
}
