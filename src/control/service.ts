import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Platform } from '../types.js'
import type { ControlOperations, KeyInput } from './types.js'

export class ZCodeControl extends TypertRemoteService implements ControlOperations {
  constructor(ctx: Context, private readonly operations: ControlOperations) {
    super(ctx, 'zcode')
  }

  @Remote status() { return this.operations.status() }
  @Remote beginLogin(platform: Platform) { return this.operations.beginLogin(platform) }
  @Remote cancelLogin(platform: Platform) { return this.operations.cancelLogin(platform) }
  @Remote disconnect(platform: Platform) { return this.operations.disconnect(platform) }
  @Remote useApiKey(input: KeyInput) { return this.operations.useApiKey(input) }
  @Remote refreshModels(platform: Platform) { return this.operations.refreshModels(platform) }
  @Remote readQuota(platform: Platform) { return this.operations.readQuota(platform) }
  @Remote refreshQuota(platform: Platform) { return this.operations.refreshQuota(platform) }
}
