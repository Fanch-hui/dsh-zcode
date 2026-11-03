export class AuthError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code)
    this.name = 'AuthError'
  }
}

export type Fetcher = typeof fetch
type JsonObject = Record<string, unknown>

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function data(value: unknown): unknown {
  const envelope = object(value)
  if (!envelope || ![0, 200, '0', '200'].includes(envelope.code as string | number)) {
    throw new AuthError('ZCODE_INVALID_RESPONSE')
  }
  return envelope.data
}

async function limitedText(response: Response): Promise<string> {
  if (!response.body) throw new AuthError('ZCODE_INVALID_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 64 * 1024) throw new AuthError('ZCODE_INVALID_RESPONSE')
      result += decoder.decode(chunk.value, { stream: true })
    }
    return result + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function requestJson(fetcher: Fetcher, url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  combined.throwIfAborted()
  let response: Response
  try {
    response = await fetcher(url, { ...init, signal: combined, redirect: 'error' })
  } catch {
    if (signal?.aborted) throw signal.reason
    throw new AuthError(timeout.aborted ? 'ZCODE_AUTH_TIMEOUT' : 'ZCODE_AUTH_NETWORK')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new AuthError(`ZCODE_AUTH_HTTP_${response.status}`, response.status)
  }
  try {
    return JSON.parse(await limitedText(response)) as unknown
  } catch (error) {
    if (combined.aborted) {
      if (signal?.aborted) throw signal.reason
      throw new AuthError('ZCODE_AUTH_TIMEOUT')
    }
    if (error instanceof AuthError) throw error
    throw new AuthError('ZCODE_INVALID_RESPONSE')
  }
}

export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
