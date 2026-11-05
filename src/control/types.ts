import type { Settings } from '../config.js'
import type { AccountStatus, Plan, Platform, QuotaSnapshot, UsageSnapshot } from '../types.js'

export interface ZCodeStatus {
  accounts: AccountStatus[]
  settings: Settings
  models: { provider: string; id: string; name: string }[]
  quotas: { platform: Platform; plan?: Plan; snapshot?: QuotaSnapshot; errorCode?: string }[]
  usage?: UsageSnapshot
}

export interface KeyInput { platform: Platform; key: string }

export interface ControlOperations {
  status(): Promise<ZCodeStatus>
  beginLogin(platform: Platform): Promise<ZCodeStatus>
  cancelLogin(platform: Platform): Promise<ZCodeStatus>
  disconnect(platform: Platform): Promise<ZCodeStatus>
  useApiKey(input: KeyInput): Promise<ZCodeStatus>
  refreshModels(platform: Platform, plan?: Plan): Promise<ZCodeStatus>
  readQuota(platform: Platform, plan?: Plan): Promise<ZCodeStatus>
  refreshQuota(platform: Platform, plan?: Plan): Promise<ZCodeStatus>
}
