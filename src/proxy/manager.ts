import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthError } from '../auth/http.js'
import type { Plan, Platform } from '../types.js'
import type { ProxyEngine, UpstreamCredential, UpstreamPort } from './types.js'

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface ManagerOptions {
  deviceId(): Promise<string>
  workerUrl?: URL
}

/** Each account/plan owns its process and the upstream module's caches. */
export class UpstreamManager implements UpstreamPort {
  private readonly engines = new Map<string, Engine>()
  private disposed = false

  constructor(private readonly options: ManagerOptions) {}

  get(platform: Platform, scope = 'auth'): ProxyEngine {
    if (this.disposed) throw new AuthError('ZCODE_DISPOSED')
    const key = `${platform}:${scope}`
    let engine = this.engines.get(key)
    if (!engine || engine.closed) {
      engine = new Engine(platform, this.options)
      this.engines.set(key, engine)
    }
    return engine
  }

  invalidate(platform: Platform): void {
    for (const [key, engine] of this.engines) {
      if (!key.startsWith(`${platform}:`)) continue
      this.engines.delete(key)
      engine.dispose()
    }
  }

  release(platform: Platform, scope: string): void {
    const key = `${platform}:${scope}`
    this.engines.get(key)?.dispose()
    this.engines.delete(key)
  }

  dispose(): void {
    this.disposed = true
    for (const engine of this.engines.values()) engine.dispose()
    this.engines.clear()
  }
}

class Engine implements ProxyEngine {
  readonly apiKey = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, Pending>()
  private readonly ready: Promise<void>
  private child?: ChildProcess
  private directory?: string
  private stopped = false
  private url?: Promise<string>
  private plan?: Plan

  get closed(): boolean { return this.stopped }

  constructor(private readonly platform: Platform, private readonly options: ManagerOptions) {
    this.ready = this.initialize()
    // Initialization can finish before its first consumer attaches.
    void this.ready.catch(() => {})
  }

  async rpc<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    await cancellable(this.ready, signal)
    return this.send<T>(method, params, signal)
  }

  async start(plan: Plan, credential: UpstreamCredential, signal?: AbortSignal): Promise<string> {
    if (this.plan && this.plan !== plan) throw new AuthError('ZCODE_ACCOUNT_CHANGED')
    this.plan = plan
    this.url ??= this.rpc<{ url: string }>('start', { plan, credential }, signal).then(result => {
      const url = new URL(result.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
        throw new AuthError('ZCODE_PROXY_INVALID_RESPONSE')
      }
      return new URL('/v1/messages', url).href
    }).catch(error => { this.url = undefined; throw error })
    return cancellable(this.url, signal)
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.fail(new AuthError('ZCODE_DISPOSED'))
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }

  private async initialize(): Promise<void> {
    try {
      const deviceId = await this.options.deviceId()
      if (this.stopped) throw new AuthError('ZCODE_DISPOSED')
      this.directory = await mkdtemp(join(tmpdir(), 'dsh-zcode-proxy-'))
      if (this.stopped) throw new AuthError('ZCODE_DISPOSED')
      const worker = this.options.workerUrl ?? new URL('./upstream.cjs', import.meta.url)
      const child = this.child = fork(fileURLToPath(worker), [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: workerEnvironment(this.directory), serialization: 'json',
      })
      child.on('message', message => this.receive(message))
      child.once('error', () => this.fail(new AuthError('ZCODE_PROXY_START_FAILED')))
      child.once('exit', () => {
        this.stopped = true
        this.fail(new AuthError('ZCODE_PROXY_STOPPED'))
        void this.clean().catch(() => {})
      })
      await this.send('init', {
        platform: this.platform, deviceId, apiKey: this.apiKey,
        configPath: join(this.directory, 'config.json'),
      }, AbortSignal.timeout(15_000))
    } catch (error) {
      this.dispose()
      await this.clean()
      throw error instanceof AuthError ? error : new AuthError('ZCODE_PROXY_START_FAILED')
    }
  }

  private send<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.stopped || !this.child?.connected) return Promise.reject(new AuthError('ZCODE_PROXY_STOPPED'))
    const id = randomUUID()
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.child!.send({ id, method, params }, error => {
        if (!error) return
        this.pending.delete(id)
        reject(new AuthError('ZCODE_PROXY_STOPPED'))
      })
    })
    return cancellable(response, signal).finally(() => this.pending.delete(id))
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'string') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if ('error' in message) pending.reject(new AuthError('ZCODE_UPSTREAM_FAILED'))
    else pending.resolve('result' in message ? message.result : undefined)
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async clean(): Promise<void> {
    if (!this.directory) return
    const directory = this.directory
    this.directory = undefined
    await rm(directory, { recursive: true, force: true })
  }
}

function workerEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1', ZCODE_PROXY_STORE_DIR: directory,
    ZCODE_CLAIM_ENABLED: 'false', ZCODE_CLAIM_AUTO: 'false',
    ZCODE_MCP_GATEWAY: 'false', ZCODE_CAPTCHA_AUTO: 'false',
  }
  for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
