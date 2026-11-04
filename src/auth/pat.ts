import type { Platform, RequestCredential } from '../types.js'
import { AuthError, data, number, object, requestJson, string, waitFor, type Fetcher } from './http.js'
import type { KeyLocation, StoredGrant } from './types.js'

const BASES: Record<Platform, string> = { bigmodel: 'https://bigmodel.cn', zai: 'https://api.z.ai' }
interface CachedPat { credential: RequestCredential; expiresAt: number; refreshAt: number }
interface BusinessToken { value: string; expiresAt?: number; refreshAt: number }

function transient(error: unknown): boolean {
  return error instanceof AuthError && (error.code === 'ZCODE_AUTH_NETWORK' || error.code === 'ZCODE_AUTH_TIMEOUT'
    || error.status === 429 || (error.status !== undefined && error.status >= 500))
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')))
    const expiry = number(payload?.exp)
    return expiry === undefined ? undefined : expiry * 1000
  } catch { return undefined }
}

export class PatManager {
  private current?: CachedPat
  private pending?: Promise<RequestCredential>
  private business?: BusinessToken
  private revision = 0
  private location?: KeyLocation

  constructor(private readonly deps: {
    platform: Platform
    grant: StoredGrant
    fetch: Fetcher
    now: () => number
    random: () => number
    signal: AbortSignal
    check: () => void
    setLocation: (location: KeyLocation | undefined) => Promise<void>
  }) { this.location = deps.grant.payload.location }

  invalidate(credential: RequestCredential): void {
    if (this.current?.credential.revision === credential.revision) this.current = undefined
  }

  async resolve(signal?: AbortSignal): Promise<RequestCredential> {
    signal?.throwIfAborted()
    this.deps.check()
    if (this.current && this.deps.now() < Math.min(this.current.refreshAt, this.current.expiresAt)) {
      return this.current.credential
    }
    if (!this.pending) {
      const pending = this.refresh().finally(() => { if (this.pending === pending) this.pending = undefined })
      this.pending = pending
    }
    const value = await waitFor(this.pending, signal)
    this.deps.check()
    signal?.throwIfAborted()
    return value
  }

  private async refresh(): Promise<RequestCredential> {
    const previous = this.current
    try {
      const startedAt = this.deps.now()
      const raw = await this.issue()
      this.deps.check()
      const value = object(data(raw))
      if (value?.enable === false) throw new AuthError('ZCODE_PAT_DISABLED')
      const token = string(value?.accessToken)
      const expiresIn = number(value?.expiresIn)
      const expiry = number(value?.expiresAt)
      if (!token || value?.tokenType !== 'Bearer' || !expiresIn || expiresIn <= 0 || !expiry || expiry <= 0) {
        throw new AuthError('ZCODE_INVALID_RESPONSE')
      }
      const expiresAt = Math.min(expiry * 1000, startedAt + expiresIn * 1000)
      if (expiresAt <= this.deps.now()) throw new AuthError('ZCODE_INVALID_RESPONSE')
      const credential: RequestCredential = {
        token, kind: 'pat', revision: ++this.revision,
        routing: { apiKeyId: this.location?.apiKeyId, zcodeToken: this.deps.grant.payload.zcodeToken },
      }
      const jitter = Math.max(0, Math.min(1, this.deps.random())) * 60_000
      this.current = { credential, expiresAt, refreshAt: expiresAt - 120_000 - jitter }
      return credential
    } catch (error) {
      this.deps.check()
      if (transient(error) && previous && this.current === previous && previous.expiresAt > this.deps.now()) {
        previous.refreshAt = Math.min(previous.expiresAt, this.deps.now() + 5000)
        return previous.credential
      }
      if (this.current === previous) this.current = undefined
      throw error
    }
  }

  private async issue(): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const login = this.deps.platform === 'zai' ? await this.businessToken() : this.deps.grant.payload.oauthAccessToken
      try { return await this.issueWithLogin(login) }
      catch (error) {
        if (this.deps.platform !== 'zai' || !(error instanceof AuthError) || error.status !== 401 || attempt > 0) throw error
        if (this.business?.value === login) this.business = undefined
      }
    }
    throw new AuthError('ZCODE_AUTH_FAILED')
  }

  private async businessToken(): Promise<string> {
    if (this.business && this.deps.now() < this.business.refreshAt) return this.business.value
    const startedAt = this.deps.now()
    let raw: unknown
    try {
      raw = await this.request(`${BASES.zai}/api/auth/z/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.deps.grant.payload.oauthAccessToken }),
      })
    } catch (error) {
      if (transient(error) && this.business?.expiresAt && this.business.expiresAt > this.deps.now()) {
        this.business.refreshAt = Math.min(this.business.expiresAt, this.deps.now() + 5000)
        return this.business.value
      }
      throw error
    }
    const value = object(data(raw))
    const token = string(value?.access_token) ?? string(value?.accessToken)
    if (!token) throw new AuthError('ZCODE_INVALID_RESPONSE')
    const ttl = number(value?.expires_in) ?? number(value?.expiresIn)
    const deadlines = [jwtExpiry(token), ttl !== undefined && ttl > 0 ? startedAt + ttl * 1000 : undefined]
      .filter((value): value is number => value !== undefined)
    const expiresAt = deadlines.length ? Math.min(...deadlines) : undefined
    const cacheUntil = expiresAt ?? startedAt + 300_000
    if (cacheUntil <= this.deps.now()) throw new AuthError('ZCODE_INVALID_RESPONSE')
    this.business = { value: token, expiresAt, refreshAt: cacheUntil - 120_000 }
    return token
  }

  private async issueWithLogin(login: string): Promise<unknown> {
    const location = this.location ?? await this.findLocation(login)
    const endpoint = `${this.keyListUrl(location)}/${encodeURIComponent(location.apiKeyId)}/access_tokens`
    try {
      const result = await this.request(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${login}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientType: 'zcode', clientVersion: '0.1.0' }),
      })
      const code = object(result)?.code
      if (code === 404 || code === '404') throw new AuthError('ZCODE_AUTH_HTTP_404', 404)
      return result
    } catch (error) {
      if (error instanceof AuthError && error.status === 404) {
        this.location = undefined
        await this.deps.setLocation(undefined)
      }
      throw error
    }
  }

  private async findLocation(login: string): Promise<KeyLocation> {
    const base = BASES[this.deps.platform]
    const headers = { Authorization: login, 'Content-Type': 'application/json' }
    const customer = object(data(await this.request(`${base}/api/biz/customer/getCustomerInfo`, { method: 'GET', headers })))
    if (!Array.isArray(customer?.organizations)) throw new AuthError('ZCODE_INVALID_RESPONSE')
    const organizations = customer.organizations.map(object).filter((entry): entry is Record<string, unknown> =>
      !!entry && !!string(entry.organizationId) && Array.isArray(entry.projects) && entry.projects.length > 0)
    const org = organizations.find(entry => string(entry.organizationName)?.includes('默认机构')) ?? organizations[0]
    const projects = Array.isArray(org?.projects) ? org.projects.map(object).filter((entry): entry is Record<string, unknown> => !!entry && !!string(entry.projectId)) : []
    const project = projects.find(entry => string(entry.projectName)?.includes('默认项目')) ?? projects[0]
    const organizationId = string(org?.organizationId)
    const projectId = string(project?.projectId)
    if (!organizationId || !projectId) throw new AuthError('ZCODE_PROJECT_UNAVAILABLE')
    const scope = { organizationId, projectId }
    const keyUrl = this.keyListUrl(scope)
    const keyHeaders = { ...headers, Authorization: this.deps.platform === 'zai' ? `Bearer ${login}` : login }
    const list = data(await this.request(keyUrl, { method: 'GET', headers: keyHeaders }))
    if (!Array.isArray(list)) throw new AuthError('ZCODE_INVALID_RESPONSE')
    let candidate = list.map(object).find(entry => entry?.name === 'zcode-api-key')
    if (!candidate) candidate = object(data(await this.request(keyUrl, {
      method: 'POST', headers: keyHeaders, body: JSON.stringify({ name: 'zcode-api-key', usageScene: 1 }),
    })))
    const apiKeyId = string(candidate?.apiKey)
    if (!apiKeyId) throw new AuthError('ZCODE_INVALID_RESPONSE')
    const location = { ...scope, apiKeyId }
    await this.deps.setLocation(location)
    this.deps.check()
    this.location = location
    return location
  }

  private keyListUrl(location: Pick<KeyLocation, 'organizationId' | 'projectId'>): string {
    return `${BASES[this.deps.platform]}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    this.deps.check()
    const value = await requestJson(this.deps.fetch, url, init, this.deps.signal)
    this.deps.check()
    return value
  }
}
