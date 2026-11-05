import { randomUUID } from 'node:crypto'
import {
  LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy, projectImagesForTextModel,
  type GenerateOptions, type StreamChunk, type PreparedAdapterCall, type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Settings } from '../config.js'
import type { AccountSnapshot, AuthPort, ModelRoute, RequestCredential } from '../types.js'
import { buildRequest, parseStream, type ResolveImage } from '../protocol/index.js'
import { RequestScheduler } from '../transport/scheduler.js'
import { httpFailure, retryAfter } from '../transport/http.js'
import { MODELS, platformFor, planFor, providerName, resolveModel } from './catalog.js'
import { startPlanResponseFailure } from '../transport/start-plan.js'
import { upstreamSession } from './session.js'
import { providerFailure } from './errors.js'

export interface AdapterDependencies {
  auth: AuthPort
  settings(): Settings
  fetch?: typeof fetch
  image?: ResolveImage
  sessionScope?: string
  scheduler?: RequestScheduler
  onUsage?: (route: ModelRoute, usage: TokenUsage) => void
}

export class ZCodeAdapter extends LlmAdapter {
  private readonly shutdown = new AbortController()
  private readonly series = new WeakMap<AbortSignal, Map<string, AccountSnapshot>>()
  private readonly scheduler: RequestScheduler

  constructor(private readonly dependencies: AdapterDependencies) {
    super()
    this.scheduler = dependencies.scheduler ?? new RequestScheduler()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: providerName(provider) }
  }

  override providerRetryPolicy(provider = 'zcode-bigmodel') {
    return resolveRetryPolicy({
      mode: 'normal', maxRetries: 1,
      retryableCodes: planFor(provider) === 'start-plan'
        ? ['SERVER', 'TIMEOUT', 'TRANSPORT']
        : ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    }, 'dsh-zcode.retryPolicy')
  }

  override async listModels(provider: string) {
    const settings = this.dependencies.settings()
    return MODELS.map(model => resolveModel(provider, model, settings))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return resolveModel(provider, model, this.dependencies.settings())
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    this.shutdown.signal.throwIfAborted()
    const settings = Object.freeze({ ...this.dependencies.settings() })
    const metadata = resolveModel(provider, model, settings)
    const account = await this.bindAccount(provider, signal)
    return { model: metadata, stream: options => this.streamAccount(account, settings, options) }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const settings = Object.freeze({ ...this.dependencies.settings() })
    yield* this.streamAccount(await this.bindAccount(options.provider, options.signal), settings, options)
  }

  dispose(): void {
    this.shutdown.abort(new LlmError('ZCode 插件已停止。', 'ABORTED'))
    this.scheduler.dispose()
  }

  private async bindAccount(provider: string, signal?: AbortSignal): Promise<AccountSnapshot> {
    signal?.throwIfAborted()
    const bound = signal ? this.series.get(signal)?.get(provider) : undefined
    if (bound) { bound.signal.throwIfAborted(); return bound }
    let account: AccountSnapshot
    try {
      const platform = platformFor(provider)
      const plan = planFor(provider)
      account = await this.dependencies.auth.snapshot(platform, signal, plan)
      if ((await this.dependencies.auth.status(platform, plan)).state === 'quota_exhausted') {
        throw new LlmError('套餐额度已用尽，请刷新用量查看重置时间。', 'QUOTA_EXHAUSTED')
      }
    } catch (error) { throw providerFailure(error) }
    account.signal.throwIfAborted()
    if (signal) {
      const bindings = this.series.get(signal) ?? new Map()
      bindings.set(provider, account)
      this.series.set(signal, bindings)
    }
    return account
  }

  private async *streamAccount(account: AccountSnapshot, settings: Settings,
    options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const local = new AbortController()
    const timeout = AbortSignal.timeout(settings.timeoutMs)
    const signal = AbortSignal.any([
      local.signal, timeout, account.signal, this.shutdown.signal,
      ...(options.signal ? [options.signal] : []),
    ])
    let release: (() => void) | undefined
    let committed = false
    try {
      signal.throwIfAborted()
      const model = resolveModel(options.provider, options.model, settings)
      if (platformFor(options.provider) !== account.platform || planFor(options.provider) !== (account.plan ?? 'coding-plan')) {
        throw new LlmError('账号或套餐与所选模型不一致。', 'AUTH')
      }
      const context = {
        provider: options.provider, model: options.model, scope: account.scope,
        plan: account.plan,
        defaultMaxTokens: settings.maxTokens, defaultEffort: settings.effort,
      }
      const messages = model.inputModalities?.includes('image')
        ? options.messages : [...projectImagesForTextModel(options.messages)]
      const body = await buildRequest({ ...options, messages, signal }, context, this.dependencies.image)
      const session = upstreamSession(this.dependencies.sessionScope ?? 'dsh', account, options)
      const accountKey = `${account.platform}:${account.scope}:${account.plan ?? 'coding-plan'}`
      release = await this.scheduler.acquire(accountKey, options.sessionId ?? session, settings.concurrency, signal)
      const credential = await this.dependencies.auth.credential(account, signal)
      const url = proxyEndpoint(credential)
      signal.throwIfAborted()
      if ((await this.dependencies.auth.status(account.platform, account.plan)).state === 'quota_exhausted') {
        throw new LlmError('套餐额度已用尽，请刷新用量查看重置时间。', 'QUOTA_EXHAUSTED')
      }
      signal.throwIfAborted()
      const response = await (this.dependencies.fetch ?? fetch)(url, {
        method: 'POST', redirect: 'error', signal, body: JSON.stringify(body),
        headers: requestHeaders(credential, session),
      })
      if (account.plan === 'start-plan') {
        const failure = await startPlanResponseFailure(response)
        if (failure) {
          if (failure.code === 'AUTH') this.dependencies.auth.markState(account, 'reauth_required', failure.code)
          if (failure.code === 'RATE_LIMIT') this.scheduler.cooldown(accountKey, retryAfter(response) ?? 1000)
          throw failure
        }
      }
      if (!response.ok) {
        const delay = retryAfter(response)
        const failure = await httpFailure(response, account, credential, this.dependencies.auth, delay)
        if (response.status === 429 && (failure.code === 'RATE_LIMIT' || failure.code === 'SERVER')) {
          this.scheduler.cooldown(accountKey, delay ?? 1000)
        }
        throw failure
      }
      if (!response.body) throw new LlmError('平台返回空响应。', 'TRANSPORT')
      for await (let chunk of parseStream(response.body, context, signal)) {
        signal.throwIfAborted()
        if (chunk.type === 'usage') this.dependencies.onUsage?.({ provider: options.provider, model: options.model }, chunk.usage)
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          const code = chunk.reason.failure.code
          if (code === 'QUOTA_EXHAUSTED' && account.plan !== 'start-plan') {
            this.dependencies.auth.markState(account, 'quota_exhausted', code)
          }
          if (code === 'AUTH' && account.plan === 'start-plan') this.dependencies.auth.markState(account, 'reauth_required', code)
          if (committed) chunk = { type: 'finish', reason: { kind: 'error', failure: {
            code: 'ZCODE_STREAM_INTERRUPTED', message: '模型输出中断，请从当前会话继续。',
          } } }
        }
        committed ||= isModelContent(chunk)
        yield chunk
      }
    } catch (error) {
      if (signal.aborted && (!timeout.aborted || account.signal.aborted || options.signal?.aborted || this.shutdown.signal.aborted)) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'ZCode 请求已停止。' } } }
        return
      }
      if (committed) throw new LlmError('模型输出中断，请从当前会话继续。', 'ZCODE_STREAM_INTERRUPTED')
      if (timeout.aborted) throw new LlmError('ZCode 请求超时，请重试当前步骤。', 'TIMEOUT')
      throw providerFailure(error)
    } finally {
      local.abort()
      release?.()
    }
  }
}

function requestHeaders(credential: RequestCredential, session: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...attributionHeaders(), 'content-type': 'application/json', accept: 'text/event-stream',
    'anthropic-version': '2023-06-01', 'x-api-key': credential.token,
    authorization: `Bearer ${credential.token}`, 'x-session-id': session, 'x-request-id': randomUUID(),
  }
  return headers
}

function proxyEndpoint(credential: RequestCredential): string {
  if (credential.kind !== 'proxy' || !credential.url) {
    throw new LlmError('ZCode 本机代理尚未就绪，请重新连接。', 'TRANSPORT')
  }
  const url = new URL(credential.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1/messages') {
    throw new LlmError('ZCode 本机代理地址无效。', 'TRANSPORT')
  }
  return url.href
}

function isModelContent(chunk: StreamChunk): boolean {
  if (chunk.type === 'block-end') {
    return chunk.block.type === 'tool-call' ||
      (chunk.block.type === 'text' || chunk.block.type === 'reasoning') && chunk.block.text.length > 0
  }
  return chunk.type === 'tool-call-delta' ||
    (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0
}
