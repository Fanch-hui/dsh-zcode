import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AuthPort, AccountStatus, ModelRoute, Plan, Platform, QuotaSnapshot } from './types.js'
import type { Settings } from './config.js'
import type { ControlOperations, KeyInput, ZCodeStatus } from './control/types.js'
import { AuthError } from './auth/http.js'
import { modelsForProvider, PROVIDERS, providerFor, resolveModel } from './provider/catalog.js'
import { TokenUsageTracker } from './usage.js'

interface QuotaView { scope: string; generation: number; snapshot?: QuotaSnapshot; errorCode?: string }
const platforms: readonly Platform[] = ['bigmodel', 'zai']
const plans: readonly Plan[] = ['coding-plan', 'start-plan']
const quotaKey = (platform: Platform, plan: Plan) => `${platform}:${plan}`

export class ZCodeRuntime implements ControlOperations {
  private readonly quotas = new Map<string, QuotaView>()
  private readonly generations = new Map<Platform, number>()
  private readonly usage = new TokenUsageTracker()
  private disposed = false

  constructor(private readonly auth: AuthPort, private readonly settings: () => Settings,
    private readonly modelsUpdated: (provider: string) => void) {}

  async status(): Promise<ZCodeStatus> {
    const accounts = await Promise.all(plans.flatMap(plan => platforms.map(async platform => ({
      ...await this.auth.status(platform, plan), plan,
    }))))
    const settings = this.settings()
    return {
      accounts, settings, usage: this.usage.snapshot(),
      models: PROVIDERS.flatMap(provider => modelsForProvider(provider).map(id => {
        const model = resolveModel(provider, id, settings)
        return { provider, id, name: model.name }
      })),
      quotas: accounts.map(account => {
        const plan = account.plan ?? 'coding-plan'
        const cached = this.quotas.get(quotaKey(account.platform, plan))
        if (!cached || cached.scope !== account.scope || cached.generation !== account.generation) return { platform: account.platform, plan }
        return { platform: account.platform, plan, ...(cached.snapshot ? { snapshot: cached.snapshot } : {}),
          ...(cached.errorCode ? { errorCode: cached.errorCode } : {}) }
      }),
    }
  }

  recordUsage(route: ModelRoute, usage: TokenUsage): void { this.usage.record(route, usage) }

  onAccountChanged(account: AccountStatus): void {
    if (this.disposed) return
    for (const plan of plans) this.modelsUpdated(providerFor(account.platform, plan))
    const previous = this.generations.get(account.platform)
    this.generations.set(account.platform, account.generation)
    if (!account.scope || previous !== account.generation) {
      for (const plan of plans) this.quotas.delete(quotaKey(account.platform, plan))
    }
    if (account.state === 'ready' && previous !== account.generation) {
      void this.loadQuota(account.platform, this.settings().plan ?? 'coding-plan', false).catch(() => {})
    }
  }

  async beginLogin(platform: Platform) { await this.auth.beginLogin(platform); return this.status() }
  async cancelLogin(platform: Platform) { await this.auth.cancelLogin(platform); return this.status() }
  async disconnect(platform: Platform) {
    await this.auth.disconnect(platform)
    for (const plan of plans) this.quotas.delete(quotaKey(platform, plan))
    return this.status()
  }
  async useApiKey(input: KeyInput) { await this.auth.useApiKey(input.platform, input.key); return this.status() }
  async refreshModels(platform: Platform, plan: Plan = 'coding-plan') { this.modelsUpdated(providerFor(platform, plan)); return this.status() }
  async readQuota(platform: Platform, plan: Plan = 'coding-plan') { await this.loadQuota(platform, plan, false); return this.status() }
  async refreshQuota(platform: Platform, plan: Plan = 'coding-plan') { await this.loadQuota(platform, plan, true); return this.status() }

  dispose(): void { this.disposed = true; this.quotas.clear() }

  private async loadQuota(platform: Platform, plan: Plan, force: boolean): Promise<void> {
    const account = await this.auth.snapshot(platform, undefined, plan)
    const key = quotaKey(platform, plan)
    const previous = this.quotas.get(key)
    let snapshot: QuotaSnapshot | undefined
    let errorCode: string | undefined
    try { snapshot = await this.auth.queryQuota(account, undefined, force) }
    catch (error) { errorCode = error instanceof AuthError ? error.code : 'ZCODE_QUOTA_UNAVAILABLE' }
    if (this.disposed || account.signal.aborted) return
    const current = await this.auth.status(platform, plan)
    if (current.scope !== account.scope || current.generation !== account.generation) return
    this.quotas.set(key, {
      scope: account.scope, generation: account.generation,
      ...(snapshot ? { snapshot } : previous?.scope === account.scope && previous.generation === account.generation ? { snapshot: previous.snapshot } : {}),
      ...(errorCode ? { errorCode } : {}),
    })
  }
}
