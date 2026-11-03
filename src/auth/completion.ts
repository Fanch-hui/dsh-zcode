import { AuthError } from './http.js'

interface Outcome { errorCode?: string }

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
