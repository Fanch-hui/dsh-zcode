import { LlmError } from '@deepseek-ai/dsh-llm'

interface Waiter {
  resolve(release: () => void): void
  reject(error: unknown): void
  signal?: AbortSignal
  abort(): void
}
interface AccountQueue {
  active: number
  limit: number
  sessions: Map<string, Waiter[]>
  cooldownUntil: number
  timer?: ReturnType<typeof setTimeout>
}

/** A round-robin queue per account; a slot covers only a model HTTP attempt. */
export class RequestScheduler {
  private readonly accounts = new Map<string, AccountQueue>()
  private disposed = false

  acquire(account: string, session: string, limit: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.disposed) return Promise.reject(new LlmError('ZCode 插件已停止。', 'ABORTED'))
    const queue = this.accounts.get(account) ?? { active: 0, limit, sessions: new Map(), cooldownUntil: 0 }
    queue.limit = limit
    this.accounts.set(account, queue)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject, signal,
        abort: () => {
          const pending = queue.sessions.get(session)
          const index = pending?.indexOf(waiter) ?? -1
          if (pending && index >= 0) pending.splice(index, 1)
          if (pending?.length === 0) queue.sessions.delete(session)
          signal?.removeEventListener('abort', waiter.abort)
          reject(signal?.reason ?? new LlmError('请求已取消。', 'ABORTED'))
          this.pump(account, queue)
        },
      }
      const pending = queue.sessions.get(session) ?? []
      pending.push(waiter)
      queue.sessions.set(session, pending)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.pump(account, queue)
    })
  }

  cooldown(account: string, delayMs: number): void {
    const queue = this.accounts.get(account)
    if (!queue || !Number.isFinite(delayMs) || delayMs <= 0) return
    queue.cooldownUntil = Math.max(queue.cooldownUntil, Date.now() + delayMs)
    this.pump(account, queue)
  }

  dispose(): void {
    this.disposed = true
    for (const queue of this.accounts.values()) {
      if (queue.timer) clearTimeout(queue.timer)
      for (const waiters of queue.sessions.values()) for (const waiter of waiters) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
        waiter.reject(new LlmError('ZCode 插件已停止。', 'ABORTED'))
      }
      queue.sessions.clear()
    }
    this.accounts.clear()
  }

  private pump(account: string, queue: AccountQueue): void {
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = undefined }
    if (this.disposed) return
    const delay = queue.cooldownUntil - Date.now()
    if (delay > 0) {
      queue.timer = setTimeout(() => this.pump(account, queue), Math.min(delay, 2_147_483_647))
      queue.timer.unref?.()
      return
    }
    while (queue.active < queue.limit && queue.sessions.size > 0) {
      const [session, pending] = queue.sessions.entries().next().value!
      const waiter = pending.shift()!
      queue.sessions.delete(session)
      if (pending.length > 0) queue.sessions.set(session, pending)
      waiter.signal?.removeEventListener('abort', waiter.abort)
      if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue }
      queue.active++
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        queue.active--
        this.pump(account, queue)
      })
    }
    if (queue.active === 0 && queue.sessions.size === 0) this.accounts.delete(account)
  }
}
