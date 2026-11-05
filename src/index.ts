import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { Config, readSettings } from './config.js'
import { ZcodeAuth } from './auth/index.js'
import { ZCodeControl } from './control/service.js'
import { ZCodeAdapter } from './provider/adapter.js'
import { PROVIDERS } from './provider/catalog.js'
import { ZCodeRuntime } from './runtime.js'
import { DshCredentialStore } from './storage/credentials.js'
import { createDeviceId } from './storage/device.js'
import { UpstreamManager } from './proxy/manager.js'
import { registerAuthorizationFlows } from './cli/authorization.js'

export { Config }
export const name = 'llm-zcode'
export const inject = ['llm', 'credentials', 'typert', 'attachments', 'profileContext']

export function apply(ctx: Context, config: Config): void {
  const upstream = new UpstreamManager({ deviceId: createDeviceId(ctx.profileContext.dir) })
  const settings = () => readSettings(config)
  let runtime: ZCodeRuntime | undefined
  const auth = new ZcodeAuth({
    store: new DshCredentialStore(ctx.credentials), upstream,
    onChange: account => runtime?.onAccountChanged(account),
  })
  runtime = new ZCodeRuntime(auth, settings, provider => ctx.emit('llm/models-updated', provider))
  const adapter = new ZCodeAdapter({
    auth, settings, sessionScope: ctx.profileContext.dir,
    onUsage: (route, usage) => runtime?.recordUsage(route, usage),
    image: async (block, signal) => {
      const image = await ctx.attachments.readImage(block.attachment, signal)
      return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
    },
  })
  new ZCodeControl(ctx, runtime)
  ctx.inject(['authorization'], ctx => registerAuthorizationFlows(ctx, auth))
  ctx.on('credentials/record-updated', key => {
    const platform = key === 'llm-zcode/bigmodel' ? 'bigmodel' : key === 'llm-zcode/zai' ? 'zai' : undefined
    if (platform) void auth.reconcile(platform).catch(() => {
      ctx.logger.warn('ZCode 凭据同步失败，请重新读取连接状态。')
    })
  })
  const registration = ctx.llm.registerAdapter([...PROVIDERS], adapter)
  const directory = ctx.llm.registerConfigurableProviders(PROVIDERS.map(provider => ({
    provider, displayName: adapter.providerInfo(provider).name,
    settingsNs: 'llm-zcode', settingsPath: [], nativeAuth: { env: [], oauth: true },
  })))
  ctx.on('loader/volatile-update', () => {
    for (const provider of PROVIDERS) ctx.emit('llm/models-updated', provider)
  })
  ctx.effect(() => () => {
    registration()
    directory()
    adapter.dispose()
    runtime?.dispose()
    auth.dispose()
    upstream.dispose()
  })
}
