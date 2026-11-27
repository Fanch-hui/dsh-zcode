import type { Context } from '@deepseek-ai/cordis'
import { t } from '../i18n/index.js'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthPort, Platform } from '../types.js'
import { login } from './login.js'

/** Expose the existing account owner to any DSH authorization surface. */
export function registerAuthorizationFlows(ctx: Context, auth: AuthPort): () => void {
  const register = (platform: Platform, label: string) => ctx.authorization.registerFlow({
    key: credentialKey('llm-zcode', platform),
    label,
    methods: [{ id: 'oauth', label: t('cli.authMethod') }],
    async run(session: AuthorizationSession) {
      await login(auth, platform, session.signal, url => session.notify({ message: t('cli.authNotify'), url }))
    },
  })
  const disposers = [register('bigmodel', `ZCode · ${t('platform.bigmodelShort')}`), register('zai', `ZCode · ${t('platform.zai')}`)]
  return () => { for (const dispose of disposers) dispose() }
}
