import type { AuthPort, AccountStatus, Platform, QuotaSnapshot } from './types.js'
import type { Settings } from './config.js'
import type { ControlOperations, KeyInput, ZCodeStatus } from './control/types.js'
import { AuthError } from './auth/http.js'
import { MODELS, PROVIDERS, resolveModel } from './provider/catalog.js'

interface QuotaView { scope: string; generation: number; snapshot?: QuotaSnapshot; errorCode?: string }

export class ZCodeRuntime implements ControlOperations {
  private readonly quotas = new Map<Platform, QuotaView>()
  private readonly generations = new Map<Platform, number>()
  private disposed = false

  constructor(private readonly auth: AuthPort, private readonly settings: () => Settings,
    private readonly modelsUpdated: (provider: string) => void) {}

  async status(): Promise<ZCodeStatus> {
    const accounts = await Promise.all((['bigmodel', 'zai'] as const).map(platform => this.auth.status(platform)))
    const settings = this.settings()
    return {
      accounts, settings,
      models: PROVIDERS.flatMap(provider => MODELS.map(id => {
        const model = resolveModel(provider, id, settings)
        return { provider, id, name: model.name }
      })),
      quotas: accounts.map(account => {
        const cached = this.quotas.get(account.platform)
        if (!cached || cached.scope !== account.scope || cached.generation !== account.generation) return { platform: account.platform }
        return { platform: account.platform, ...(cached.snapshot ? { snapshot: cached.snapshot } : {}),
          ...(cached.errorCode ? { errorCode: cached.errorCode } : {}) }
      }),
    }
  }

  onAccountChanged(account: AccountStatus): void {
    if (this.disposed) return
    this.modelsUpdated(`zcode-${account.platform}`)
    const previous = this.generations.get(account.platform)
    this.generations.set(account.platform, account.generation)
    if (!account.scope || previous !== account.generation) this.quotas.delete(account.platform)
    if (account.state === 'ready' && previous !== account.generation) {
      void this.loadQuota(account.platform, false).catch(() => {})
    }
  }

  async beginLogin(platform: Platform) { await this.auth.beginLogin(platform); return this.status() }
  async cancelLogin(platform: Platform) { await this.auth.cancelLogin(platform); return this.status() }
  async disconnect(platform: Platform) {
    await this.auth.disconnect(platform)
    this.quotas.delete(platform)
    return this.status()
  }
  async useApiKey(input: KeyInput) { await this.auth.useApiKey(input.platform, input.key); return this.status() }
  async refreshModels(platform: Platform) { this.modelsUpdated(`zcode-${platform}`); return this.status() }
  async readQuota(platform: Platform) { await this.loadQuota(platform, false); return this.status() }
  async refreshQuota(platform: Platform) { await this.loadQuota(platform, true); return this.status() }

  dispose(): void { this.disposed = true; this.quotas.clear() }

  private async loadQuota(platform: Platform, force: boolean): Promise<void> {
    const account = await this.auth.snapshot(platform)
    const previous = this.quotas.get(platform)
    let snapshot: QuotaSnapshot | undefined
    let errorCode: string | undefined
    try { snapshot = await this.auth.queryQuota(account, undefined, force) }
    catch (error) { errorCode = error instanceof AuthError ? error.code : 'ZCODE_QUOTA_UNAVAILABLE' }
    if (this.disposed || account.signal.aborted) return
    const current = await this.auth.status(platform)
    if (current.scope !== account.scope || current.generation !== account.generation) return
    this.quotas.set(platform, {
      scope: account.scope, generation: account.generation,
      ...(snapshot ? { snapshot } : previous?.scope === account.scope && previous.generation === account.generation ? { snapshot: previous.snapshot } : {}),
      ...(errorCode ? { errorCode } : {}),
    })
  }
}
