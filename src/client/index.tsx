import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { contribution } from '../control/remote.js'
import { Advanced } from './Advanced.js'
import { ZCodeController, type RemoteFace } from './controller.js'
import { Settings } from './Settings.js'

export const inject = ['slots', 'remote']

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  await ctx.inject(['remote.zcode'], ctx => {
    const controller = new ZCodeController((ctx.remote as unknown as { zcode: RemoteFace }).zcode)
    ctx.effect(() => () => controller.dispose())
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: 'dsh-zcode',
    }, () => <Settings controller={controller} />))
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config', key: 'dsh-zcode#llm-zcode',
    }, ({ view, form }) => view === 'summary' ? 'ZCode 高级设置' : <Advanced form={form} />))
  })
}
