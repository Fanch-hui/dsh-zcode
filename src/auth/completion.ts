import { AuthError } from './http.js'
import type { LoginAttempt, Platform } from '../types.js'

interface Outcome { errorCode?: string }

export function validateLogin(value: LoginAttempt, platform: Platform, now: number): LoginAttempt {
  if (!value || typeof value.attemptId !== 'string' || !value.attemptId ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
    throw new AuthError('ZCODE_OAUTH_INVALID_RESPONSE')
  }
  let url: URL
  try { url = new URL(value.authorizeUrl) } catch { throw new AuthError('ZCODE_OAUTH_INVALID_URL') }
  const validHosts = platform === 'bigmodel' ? ['zcode.z.ai', 'bigmodel.cn', 'open.bigmodel.cn'] : ['zcode.z.ai', 'chat.z.ai']
  if (url.protocol !== 'https:' || !validHosts.includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new AuthError('ZCODE_OAUTH_INVALID_URL')
  }
  return { attemptId: value.attemptId, authorizeUrl: url.href, expiresAt: value.expiresAt }
}

/** Retains a bounded, non-secret outcome for a single login attempt. */
export class LoginCompletion {
  private result?: Outcome
  private resolve!: (outcome: Outcome) => void
  private readonly done = new Promise<Outcome>(resolve => { this.resolve = resolve })

  get finished(): boolean { return this.result !== undefined }

  settle(errorCode?: string): void {
    if (this.result) return
    this.result = errorCode ? { errorCode } : {}
    this.resolve(this.result)
  }

  async wait(signal: AbortSignal | undefined, committing: () => boolean): Promise<void> {
    let outcome = this.result
    if (!outcome && signal?.aborted && !committing()) throw signal.reason
    if (!outcome && signal && !signal.aborted) {
      outcome = await new Promise<Outcome>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        const onAbort = () => {
          if (committing()) { cleanup(); return }
          cleanup()
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.done.then(value => { cleanup(); resolve(value) })
      })
    }
    outcome ??= await this.done
    if (outcome.errorCode) throw new AuthError(outcome.errorCode)
  }
}
