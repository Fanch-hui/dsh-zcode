import type { Settings } from '../config.js'
import type { AccountStatus, Platform, QuotaSnapshot } from '../types.js'

export interface ZCodeStatus {
  accounts: AccountStatus[]
  settings: Settings
  models: { provider: string; id: string; name: string }[]
  quotas: { platform: Platform; snapshot?: QuotaSnapshot; errorCode?: string }[]
}

export interface KeyInput { platform: Platform; key: string }

export interface ControlOperations {
  status(): Promise<ZCodeStatus>
  beginLogin(platform: Platform): Promise<ZCodeStatus>
  cancelLogin(platform: Platform): Promise<ZCodeStatus>
  disconnect(platform: Platform): Promise<ZCodeStatus>
  useApiKey(input: KeyInput): Promise<ZCodeStatus>
  refreshModels(platform: Platform): Promise<ZCodeStatus>
  readQuota(platform: Platform): Promise<ZCodeStatus>
  refreshQuota(platform: Platform): Promise<ZCodeStatus>
}
