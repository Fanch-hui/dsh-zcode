import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Plan, Platform } from '../types.js'
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
  @Remote refreshModels(platform: Platform, plan?: Plan) { return this.operations.refreshModels(platform, plan) }
  @Remote readQuota(platform: Platform, plan?: Plan) { return this.operations.readQuota(platform, plan) }
  @Remote refreshQuota(platform: Platform, plan?: Plan) { return this.operations.refreshQuota(platform, plan) }
}
