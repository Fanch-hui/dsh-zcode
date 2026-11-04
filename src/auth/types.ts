import type { Platform } from '../types.js'
import type { UpstreamCredential } from '../proxy/types.js'
import { AuthError, object, string } from './http.js'

export interface KeyLocation { organizationId: string; projectId: string; apiKeyId: string }
export interface StoredGrant {
  kind: 'grant'
  payload: {
    schemaVersion: 1
    platform: Platform
    scope: string
    oauthAccessToken?: string
    zcodeToken?: string
    upstream?: UpstreamCredential
    accountLabel?: string
    location?: KeyLocation
  }
}
export interface StoredApiKey {
  kind: 'api-key'
  key: string
  env: { DSH_ZCODE_SCOPE: string }
}
export type StoredAccount = StoredGrant | StoredApiKey

/** The store runs assertCurrent inside its exclusive write transaction. */
export interface CredentialStore {
  load(platform: Platform): Promise<StoredAccount | undefined>
  save(platform: Platform, account: StoredAccount, assertCurrent: () => void, expected: StoredAccount | undefined): Promise<void>
  remove(platform: Platform, assertCurrent: () => void, expected: StoredAccount | undefined): Promise<void>
}

export function readAccount(value: unknown, platform: Platform): StoredAccount | undefined {
  if (value === undefined) return undefined
  const record = object(value)
  if (record?.kind === 'api-key') {
    const env = object(record.env)
    const key = string(record.key)
    const scope = string(env?.DSH_ZCODE_SCOPE)
    if (key && scope) return { kind: 'api-key', key, env: { DSH_ZCODE_SCOPE: scope } }
  }
  if (record?.kind === 'grant') {
    const payload = object(record.payload)
    const scope = string(payload?.scope)
    const oauthAccessToken = string(payload?.oauthAccessToken)
    const zcodeToken = string(payload?.zcodeToken)
    const label = string(payload?.accountLabel)
    const location = object(payload?.location)
    const organizationId = string(location?.organizationId)
    const projectId = string(location?.projectId)
    const apiKeyId = string(location?.apiKeyId)
    const upstream = readUpstream(payload?.upstream, platform)
    if (payload?.schemaVersion === 1 && payload.platform === platform && scope && (upstream || oauthAccessToken && zcodeToken)) {
      return { kind: 'grant', payload: {
        schemaVersion: 1, platform, scope,
        ...(oauthAccessToken ? { oauthAccessToken } : {}), ...(zcodeToken ? { zcodeToken } : {}),
        ...(upstream ? { upstream } : {}),
        ...(label ? { accountLabel: label.slice(0, 120) } : {}),
        ...(organizationId && projectId && apiKeyId ? { location: { organizationId, projectId, apiKeyId } } : {}),
      } }
    }
  }
  throw new AuthError('ZCODE_CREDENTIAL_INVALID')
}

function readUpstream(value: unknown, platform: Platform): UpstreamCredential | undefined {
  const credential = object(value)
  const apiKey = string(credential?.apiKey)
  if (!credential || credential.provider !== platform || !apiKey) return undefined
  const secret = string(credential.secret)
  const jwt = string(credential.jwt)
  const oauthAccessToken = string(credential.oauthAccessToken)
  const userId = string(credential.userId)
  const expiresAt = typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt)
    ? credential.expiresAt : undefined
  return {
    provider: platform, apiKey,
    ...(secret ? { secret } : {}), ...(jwt ? { jwt } : {}),
    ...(oauthAccessToken ? { oauthAccessToken } : {}), ...(userId ? { userId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

export function scopeOf(record: StoredAccount): string {
  return record.kind === 'grant' ? record.payload.scope : record.env.DSH_ZCODE_SCOPE
}
