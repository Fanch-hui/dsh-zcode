import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { AuthManager } from '../vendor/zcode-api/src/auth/manager.js'
import type { Credential } from '../vendor/zcode-api/src/auth/types.js'
import { loadConfig } from '../vendor/zcode-api/src/config/loader.js'
import type { ProxyConfig } from '../vendor/zcode-api/src/config/types.js'
import { ensureNodeFetchNoTimeouts } from '../vendor/zcode-api/src/runtime/node-fetch-compat.js'
import { collectQuotaSnapshot } from '../vendor/zcode-api/src/server/routes-quota.js'
import { startServer, type ProxyServer } from '../vendor/zcode-api/src/server/server.js'
import { controlFetch } from './control-fetch.js'
import { WorkerAuth } from './worker-auth.js'

const VERSION = '4.8.8.android'
const REVISION = '158e7653b738cbed0996243eeabd26f816638e81'
type Platform = Credential['provider']
type Plan = ProxyConfig['plan']

interface Context {
  platform: Platform
  config: ProxyConfig
  auth: AuthManager
  login: WorkerAuth
  server?: ProxyServer
  starting?: Promise<{ url: string }>
  plan?: Plan
  credential?: Credential
}

interface RpcRequest { id: string | number; method: string; params?: Record<string, unknown> }

for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) console[name] = () => {}
for (const name of Object.keys(process.env)) {
  if (name !== 'ZCODE_PROXY_STORE_DIR' && (name.startsWith('ZCODE_') || name.startsWith('CAPTCHA_'))) delete process.env[name]
}

let context: Context | null = null
let stopping: Promise<void> | null = null

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('INVALID_ARGUMENT')
  return value
}

function planValue(value: unknown): Plan {
  if (value !== 'start-plan' && value !== 'coding-plan') throw new Error('INVALID_PLAN')
  return value
}

function credentialValue(value: unknown, platform: Platform, plan?: Plan): Credential {
  if (!value || typeof value !== 'object') throw new Error('INVALID_CREDENTIAL')
  const input = value as Partial<Credential>
  if (input.provider !== platform || typeof input.apiKey !== 'string' || !input.apiKey) {
    throw new Error('INVALID_CREDENTIAL')
  }
  if (plan === 'start-plan' && (typeof input.jwt !== 'string' || !input.jwt)) {
    throw new Error('INVALID_CREDENTIAL')
  }
  const credential: Credential = { provider: platform, apiKey: input.apiKey }
  if (typeof input.secret === 'string') credential.secret = input.secret
  if (typeof input.jwt === 'string') credential.jwt = input.jwt
  if (typeof input.userId === 'string') credential.userId = input.userId
  if (typeof input.oauthAccessToken === 'string') credential.oauthAccessToken = input.oauthAccessToken
  if (typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)) credential.expiresAt = input.expiresAt
  return credential
}

function sameCredential(left: Credential | undefined, right: Credential): boolean {
  if (!left) return false
  const fields: Array<keyof Credential> = ['provider', 'apiKey', 'secret', 'jwt', 'userId', 'oauthAccessToken', 'expiresAt']
  return fields.every(field => left[field] === right[field])
}

function requireContext(): Context {
  if (!context || stopping) throw new Error('WORKER_UNAVAILABLE')
  return context
}

async function init(params: Record<string, unknown>): Promise<{ version: string; revision: string }> {
  if (context || stopping) throw new Error('ALREADY_INITIALIZED')
  const platform = params.platform
  if (platform !== 'zai' && platform !== 'bigmodel') throw new Error('INVALID_PLATFORM')
  const deviceId = text(params.deviceId)
  const apiKey = text(params.apiKey)
  const configPath = text(params.configPath)
  if (!isAbsolute(configPath)) throw new Error('INVALID_CONFIG_PATH')
  const rawConfig = {
    server: { host: '127.0.0.1', port: 1 },
    provider: platform,
    identity: { deviceMid: deviceId },
    claim: { enabled: false, auto: false },
    mcp: { enabled: false, webSearch: false, webReader: false, zread: false, gateway: { enabled: false } },
    responses: { enabled: false },
    async: { enabled: false },
  }
  writeFileSync(configPath, JSON.stringify(rawConfig), { mode: 0o600, flag: 'wx' })
  const config = loadConfig(configPath)
  if (config.claim.enabled || config.claim.auto || config.mcp.enabled || config.mcp.webSearch
    || config.mcp.webReader || config.mcp.zread || config.mcp.gateway.enabled
    || config.responses.enabled || config.async.enabled) throw new Error('UNSAFE_CONFIG')
  config.server.port = 0
  config.auth.proxyApiKey = apiKey
  context = { platform, config, auth: new AuthManager(), login: new WorkerAuth(platform) }
  await ensureNodeFetchNoTimeouts()
  return { version: VERSION, revision: REVISION }
}

async function start(params: Record<string, unknown>): Promise<{ url: string }> {
  const state = requireContext()
  const plan = planValue(params.plan)
  const credential = credentialValue(params.credential, state.platform, plan)
  if (state.server || state.starting) {
    if (state.plan !== plan || !sameCredential(state.credential, credential)) throw new Error('INSTANCE_IN_USE')
    return state.starting ?? { url: `http://127.0.0.1:${state.server!.port}` }
  }
  state.plan = plan
  state.credential = credential
  state.config.plan = plan
  state.auth.setOAuthCredential(credential)
  state.starting = (async () => {
    const server = await startServer({ config: state.config, auth: state.auth, quotaFetchImpl: controlFetch() })
    if (stopping) {
      await server.close()
      throw new Error('WORKER_STOPPING')
    }
    state.server = server
    return { url: `http://127.0.0.1:${server.port}` }
  })()
  try {
    return await state.starting
  } catch (error) {
    state.auth.clearOAuthCredential()
    state.credential = undefined
    state.plan = undefined
    throw error
  } finally {
    state.starting = undefined
  }
}

async function quota(params: Record<string, unknown>): Promise<unknown> {
  const state = requireContext()
  const plan = planValue(params.plan)
  const credential = credentialValue(params.credential, state.platform, plan)
  const snapshot = await collectQuotaSnapshot({ ...state.config, plan }, controlFetch(), async () => credential)
  return {
    ...snapshot,
    errors: snapshot.errors.map(error => {
      const source = /^(balance|preview|coding):/.exec(error)?.[1]
      return source ? `${source}: UPSTREAM_FAILED` : 'UPSTREAM_FAILED'
    }),
  }
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'init') return init(params)
  if (method === 'close') { await shutdown(); return null }
  const state = requireContext()
  if (method === 'resolve') return state.login.resolve(text(params.accessToken), typeof params.zcodeToken === 'string' ? params.zcodeToken : undefined)
  if (method === 'beginLogin') return state.login.begin()
  if (method === 'completeLogin') return state.login.complete(text(params.attemptId))
  if (method === 'cancelLogin') { await state.login.cancel(typeof params.attemptId === 'string' ? params.attemptId : undefined); return null }
  if (method === 'start') return start(params)
  if (method === 'quota') return quota(params)
  throw new Error('UNKNOWN_METHOD')
}

function shutdown(): Promise<void> {
  if (stopping) return stopping
  stopping = (async () => {
    const state = context
    if (!state) return
    await state.login.cancel()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          await state.starting?.catch(() => {})
          await state.server?.close()
        })(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2000) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      state.auth.clearOAuthCredential()
      context = null
    }
  })()
  return stopping
}

function reply(payload: object, done?: () => void): void {
  if (!process.connected || !process.send) { done?.(); return }
  try { process.send(payload, () => done?.()) } catch { done?.() }
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return
  const request = message as RpcRequest
  if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') return
  const params = request.params && typeof request.params === 'object' ? request.params : {}
  const done = request.method === 'close' ? () => process.exit(0) : undefined
  void handle(request.method, params).then(
    result => reply({ id: request.id, result }, done),
    () => reply({ id: request.id, error: { code: 'UPSTREAM_FAILED' } }, done),
  )
})

process.on('disconnect', () => { void shutdown().finally(() => process.exit(0)) })
