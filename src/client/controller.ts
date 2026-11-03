import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Platform } from '../types.js'
import type { ControlOperations, KeyInput, ZCodeStatus } from '../control/types.js'

export interface RemoteFace {
  status(): Promise<RemoteResult<ZCodeStatus>>
  beginLogin(platform: Platform): Promise<RemoteResult<ZCodeStatus>>
  cancelLogin(platform: Platform): Promise<RemoteResult<ZCodeStatus>>
  disconnect(platform: Platform): Promise<RemoteResult<ZCodeStatus>>
  useApiKey(input: KeyInput): Promise<RemoteResult<ZCodeStatus>>
  refreshModels(platform: Platform): Promise<RemoteResult<ZCodeStatus>>
  readQuota(platform: Platform): Promise<RemoteResult<ZCodeStatus>>
  refreshQuota(platform: Platform): Promise<RemoteResult<ZCodeStatus>>
}

type Action = Exclude<keyof ControlOperations, 'status' | 'useApiKey'>
export interface ClientSnapshot { status?: ZCodeStatus; pending?: string; error?: string; loading?: boolean }

export class ZCodeController {
  private value: ClientSnapshot = {}
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  private watching = 0
  private disposed = false
  private read?: Promise<void>
  private pendingPlatform?: Platform

  constructor(private readonly remote: RemoteFace) {}
  getSnapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  watch(): () => void {
    this.watching++
    if (this.watching === 1) void this.refresh()
    return () => {
      this.watching = Math.max(0, this.watching - 1)
      if (!this.watching) clearTimeout(this.timer)
    }
  }

  refresh(): Promise<void> {
    if (this.read || this.disposed || this.value.pending) return this.read ?? Promise.resolve()
    const generation = this.generation
    this.update({ ...this.value, loading: true })
    const task = Promise.resolve().then(async () => {
      try {
        const result = await this.remote.status()
        if (this.disposed || generation !== this.generation) return
        this.update(result.ok
          ? { ...this.value, status: result.value, error: undefined }
          : { ...this.value, error: '读取连接状态失败，请重试。' })
      } catch {
        if (!this.disposed && generation === this.generation) this.update({ ...this.value, error: '连接 DSH 服务失败，请重试。' })
      } finally {
        this.read = undefined
        if (!this.disposed) {
          this.update({ ...this.value, loading: false })
          this.schedule()
        }
      }
    })
    this.read = task
    return task
  }

  async run(action: Action, platform: Platform): Promise<boolean> {
    const cancellingStart = action === 'cancelLogin' && this.value.pending === 'beginLogin' && this.pendingPlatform === platform
    return this.mutate(action, platform, () => this.remote[action](platform), cancellingStart)
  }

  async setKey(input: KeyInput): Promise<boolean> {
    return this.mutate('useApiKey', input.platform, () => this.remote.useApiKey(input))
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private async mutate(action: string, platform: Platform, invoke: () => Promise<RemoteResult<ZCodeStatus>>, interrupt = false): Promise<boolean> {
    if (this.disposed || (this.value.pending && !interrupt)) return false
    const generation = ++this.generation
    this.pendingPlatform = platform
    clearTimeout(this.timer)
    this.update({ ...this.value, pending: action, error: undefined })
    try {
      const result = await invoke()
      if (this.disposed || generation !== this.generation) return false
      this.pendingPlatform = undefined
      if (!result.ok) {
        this.update({ ...this.value, pending: undefined, error: '操作未完成，请检查连接后重试。' })
        return false
      }
      this.update({ ...this.value, status: result.value, pending: undefined, error: undefined })
      return true
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.pendingPlatform = undefined
        this.update({ ...this.value, pending: undefined, error: '连接 DSH 服务失败，请重试。' })
      }
      return false
    } finally { this.schedule() }
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (!this.disposed && this.watching && !this.value.pending && this.value.status?.accounts.some(a => a.state === 'authorizing')) {
      this.timer = setTimeout(() => { void this.refresh() }, 2000)
    }
  }

  private update(value: ClientSnapshot): void { this.value = value; for (const listener of this.listeners) listener() }
}
