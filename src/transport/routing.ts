import { LlmError } from '@deepseek-ai/dsh-llm'
import { waitFor } from '../auth/http.js'
import type { AccountSnapshot, RequestCredential } from '../types.js'
import { readBoundedJson } from './json.js'
import { modelEndpoint } from './routes.js'

const CONFIG_URL = 'https://zcode.z.ai/api/v1/agent/configs'
const CONFIG_TTL = 300_000
const ERROR_COOLDOWN = 30_000
const TRUSTED_ORIGINS = new Set([
  'https://zcode.z.ai', 'https://api.z.ai', 'https://open.bigmodel.cn',
])

interface Target { url: string; includeIdentity: boolean }
type Snapshot = ReadonlyMap<string, Target>
interface Entry {
  group: string
  revision: number
  accountSignal: AbortSignal
  abort: () => void
  controller: AbortController
  snapshot?: Snapshot
  validUntil: number
  retryAt: number
  pending?: Promise<Snapshot>
}

class ConfigFailure extends Error {
  constructor(readonly reason: 'invalid_response' | 'upstream_error') { super(reason) }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function normalizedKey(url: URL): string {
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '443'}${path}`
}

function mappingUrl(value: unknown): URL {
  if (typeof value !== 'string' || /[?#]/.test(value)) throw new ConfigFailure('invalid_response')
  let url: URL
  try { url = new URL(value) } catch { throw new ConfigFailure('invalid_response') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ConfigFailure('invalid_response')
  return url
}

function failureReason(error: unknown, timeout: AbortSignal): string {
  if (timeout.aborted) return 'timeout'
  if (error instanceof ConfigFailure) return error.reason
  if (error instanceof SyntaxError || error instanceof RangeError) return 'invalid_response'
  return 'request_failed'
}

function parseSnapshot(value: unknown): Snapshot {
  const envelope = object(value)
  const data = object(envelope?.data)
  if (envelope?.code !== 0 || !data) throw new ConfigFailure('invalid_response')
  if (data.proxyEndpoint === undefined) return new Map()
  const proxy = object(data.proxyEndpoint)
  if (!proxy) throw new ConfigFailure('invalid_response')
  if (proxy.mapping === undefined) return new Map()
  if (!Array.isArray(proxy.mapping) || proxy.mapping.length > 256) throw new ConfigFailure('invalid_response')
  const mapping = new Map<string, Target>()
  for (const item of proxy.mapping) {
    const row = object(item)
    if (!row) throw new ConfigFailure('invalid_response')
    const from = mappingUrl(row.from)
    const to = mappingUrl(row.to)
    if (!TRUSTED_ORIGINS.has(to.origin)) throw new ConfigFailure('invalid_response')
    const marker = row.zcodeAuthorizationHeader
    if (marker !== undefined && typeof marker !== 'string') throw new ConfigFailure('invalid_response')
    const header = typeof marker === 'string' ? marker.trim() : ''
    if (header && header.toLowerCase() !== 'x-zcode-authorization') throw new ConfigFailure('invalid_response')
    if (header && (to.origin !== 'https://zcode.z.ai' || !/^\/api\/v1\/(?:ultra|ultra-zai)(?:\/|$)/.test(to.pathname))) {
      throw new ConfigFailure('invalid_response')
    }
    const key = normalizedKey(from)
    if (mapping.has(key)) throw new ConfigFailure('invalid_response')
    mapping.set(key, { url: to.href, includeIdentity: Boolean(header) })
  }
  return mapping
}

export class EndpointRouter {
  private readonly entries = new Map<string, Entry>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly onWarning?: (reason: string) => void
  private disposed = false

  constructor(options: { fetch?: typeof fetch; now?: () => number; onWarning?: (reason: string) => void } = {}) {
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.onWarning = options.onWarning
  }

  async resolve(account: AccountSnapshot, credential: RequestCredential,
    signal?: AbortSignal): Promise<{ url: string; headers?: Record<string, string> }> {
    this.assertActive(account, signal)
    const original = new URL(modelEndpoint(account))
    if (account.mode === 'api-key') return { url: original.href }
    const entry = this.entryFor(account, credential.revision)
    const snapshot = await this.snapshot(entry, credential.routing?.apiKeyId, signal)
    this.assertActive(account, signal)
    entry.controller.signal.throwIfAborted()
    const target = snapshot.get(normalizedKey(original))
    if (!target) return { url: original.href }
    const url = new URL(target.url)
    url.search = original.search
    if (!target.includeIdentity) return { url: url.href }
    const identity = credential.routing?.zcodeToken.trim()
    if (!identity) throw new LlmError('模型网关需要登录身份，请重新登录。', 'AUTH')
    const authorization = /^Bearer\s/i.test(identity) ? identity : `Bearer ${identity}`
    return { url: url.href, headers: { 'X-ZCode-Authorization': authorization } }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.accountSignal.removeEventListener('abort', entry.abort)
      entry.controller.abort(new Error('ZCode 路由服务已停止。'))
    }
    this.entries.clear()
  }

  private assertActive(account: AccountSnapshot, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    account.signal.throwIfAborted()
    if (this.disposed) throw new Error('ZCode 路由服务已停止。')
  }

  private entryFor(account: AccountSnapshot, revision: number): Entry {
    const group = JSON.stringify([account.platform, account.scope, account.generation])
    const key = JSON.stringify([account.platform, account.scope, account.generation, revision])
    const now = this.now()
    for (const entry of this.entries.values()) {
      if (entry.group === group && entry.revision !== revision && !entry.pending &&
        now >= entry.validUntil && now >= entry.retryAt) entry.abort()
    }
    const existing = this.entries.get(key)
    if (existing && existing.accountSignal === account.signal) return existing
    if (existing) existing.abort()
    const controller = new AbortController()
    const entry: Entry = {
      group, revision, accountSignal: account.signal, controller, validUntil: 0, retryAt: 0,
      abort: () => {
        account.signal.removeEventListener('abort', entry.abort)
        controller.abort(account.signal.reason ?? new Error('ZCode 账号已变更。'))
        if (this.entries.get(key) === entry) this.entries.delete(key)
      },
    }
    this.entries.set(key, entry)
    account.signal.addEventListener('abort', entry.abort, { once: true })
    return entry
  }

  private async snapshot(entry: Entry, apiKeyId: string | undefined, signal?: AbortSignal): Promise<Snapshot> {
    const now = this.now()
    if (entry.snapshot && now < entry.validUntil) return entry.snapshot
    if (now < entry.retryAt) return entry.snapshot ?? new Map()
    if (!entry.pending) {
      const pending = this.refresh(entry, apiKeyId).finally(() => {
        if (entry.pending === pending) entry.pending = undefined
      })
      entry.pending = pending
    }
    const signals = [entry.controller.signal, ...(signal ? [signal] : [])]
    return waitFor(entry.pending, AbortSignal.any(signals))
  }

  private async refresh(entry: Entry, apiKeyId: string | undefined): Promise<Snapshot> {
    const timeout = AbortSignal.timeout(3000)
    const signal = AbortSignal.any([entry.controller.signal, timeout])
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      const keyId = apiKeyId?.trim()
      if (keyId && /^[\x20-\x7e]+$/.test(keyId)) headers['x-api-key-id'] = keyId
      const response = await this.fetcher(CONFIG_URL, { method: 'GET', headers, redirect: 'error', signal })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ConfigFailure('upstream_error')
      }
      const value = await readBoundedJson(response, 262_144)
      const snapshot = parseSnapshot(value)
      entry.controller.signal.throwIfAborted()
      signal.throwIfAborted()
      entry.snapshot = snapshot
      entry.validUntil = this.now() + CONFIG_TTL
      entry.retryAt = 0
      return snapshot
    } catch (error) {
      entry.controller.signal.throwIfAborted()
      this.onWarning?.(failureReason(error, timeout))
      entry.retryAt = this.now() + ERROR_COOLDOWN
      return entry.snapshot ?? new Map()
    }
  }
}
