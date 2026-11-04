import { createHash } from 'node:crypto'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { AuthError, type CredentialStore, type StoredAccount } from '../auth/index.js'
import type { Platform } from '../types.js'

/** Each platform has one active mode and a separate, typed manual-key record. */
export class DshCredentialStore implements CredentialStore {
  private readonly invalid = new Map<Platform, string>()
  constructor(private readonly credentials: CredentialProvider) {}

  async load(platform: Platform): Promise<StoredAccount | undefined> {
    const active = await this.credentials.readRecord(credentialKey('llm-zcode', platform))
    this.invalid.delete(platform)
    if (!active) return undefined
    if (active.kind === 'grant' && active.payload && typeof active.payload === 'object') {
      const payload = active.payload as Record<string, unknown>
      if (payload.authMode === 'signed_out') return undefined
      if (payload.authMode === 'api-key') {
        const scope = typeof payload.scope === 'string' ? payload.scope : ''
        const record = scope ? await this.credentials.readRecord(manualKey(platform, scope)) : undefined
        if (record?.kind === 'api-key' && record.env?.DSH_ZCODE_SCOPE === scope) return record as StoredAccount
        this.invalid.set(platform, fingerprint(active))
        return active as StoredAccount
      }
    }
    if (!identity(active)) this.invalid.set(platform, fingerprint(active))
    return active as StoredAccount
  }

  async save(platform: Platform, record: StoredAccount, assertCurrent: () => void, expected: StoredAccount | undefined): Promise<void> {
    const activeKey = credentialKey('llm-zcode', platform)
    const oldManual = expected?.kind === 'api-key' ? manualKey(platform, expected.env.DSH_ZCODE_SCOPE) : undefined
    if (record.kind === 'api-key') {
      const key = manualKey(platform, record.env.DSH_ZCODE_SCOPE)
      await this.credentials.modifyRecord(key, async () => { assertCurrent(); return record })
      try {
        await this.credentials.modifyRecord(activeKey, async current => {
          assertCurrent()
          this.compare(platform, current, expected)
          return { kind: 'grant', payload: { schemaVersion: 1, authMode: 'api-key', scope: record.env.DSH_ZCODE_SCOPE } }
        })
      } catch (error) {
        await this.credentials.deleteRecord(key)
        throw error
      }
    } else {
      await this.credentials.modifyRecord(activeKey, async current => {
        assertCurrent()
        this.compare(platform, current, expected)
        return record
      })
    }
    this.invalid.delete(platform)
    if (oldManual) await this.credentials.deleteRecord(oldManual)
  }

  async remove(platform: Platform, assertCurrent: () => void, expected: StoredAccount | undefined): Promise<void> {
    // modifyRecord gives cancellation the same exclusive commit point as writes.
    await this.credentials.modifyRecord(credentialKey('llm-zcode', platform), async current => {
      assertCurrent()
      this.compare(platform, current, expected)
      return { kind: 'grant', payload: { schemaVersion: 1, authMode: 'signed_out' } }
    })
    this.invalid.delete(platform)
    if (expected?.kind === 'api-key') await this.credentials.deleteRecord(manualKey(platform, expected.env.DSH_ZCODE_SCOPE))
  }

  private compare(platform: Platform, current: CredentialRecord | undefined, expected: StoredAccount | undefined): void {
    const currentIdentity = identity(current)
    if (currentIdentity === identity(expected)) return
    if (expected === undefined && current && this.invalid.get(platform) === fingerprint(current)) return
    throw new AuthError('ZCODE_ACCOUNT_CHANGED')
  }
}

function manualKey(platform: Platform, scope: string) {
  const id = createHash('sha256').update(scope).digest('hex')
  return credentialKey('llm-zcode', `${platform}-key-${id}`)
}

function identity(record: CredentialRecord | undefined): string | undefined {
  if (record?.kind === 'api-key') return record.env?.DSH_ZCODE_SCOPE ? `api-key:${record.env.DSH_ZCODE_SCOPE}` : undefined
  if (record?.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return undefined
  const payload = record.payload as Record<string, unknown>
  if (payload.authMode === 'api-key' && typeof payload.scope === 'string') return `api-key:${payload.scope}`
  const upstream = payload.upstream as Record<string, unknown> | undefined
  const current = upstream && (upstream.provider === 'bigmodel' || upstream.provider === 'zai') &&
    typeof upstream.apiKey === 'string' && upstream.apiKey.length > 0
  const legacy = typeof payload.oauthAccessToken === 'string' && typeof payload.zcodeToken === 'string'
  return typeof payload.scope === 'string' && (current || legacy) ? `grant:${payload.scope}` : undefined
}

function fingerprint(record: CredentialRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}
