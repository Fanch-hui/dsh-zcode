import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthPort, Platform } from '../types.js'
import { login } from './login.js'

/** Expose the existing account owner to any DSH authorization surface. */
export function registerAuthorizationFlows(ctx: Context, auth: AuthPort): () => void {
  const register = (platform: Platform, label: string) => ctx.authorization.registerFlow({
    key: credentialKey('llm-zcode', platform),
    label,
    methods: [{ id: 'oauth', label: '浏览器授权' }],
    async run(session: AuthorizationSession) {
      await login(auth, platform, session.signal, url => session.notify({ message: '请在浏览器完成授权。', url }))
    },
  })
  const disposers = [register('bigmodel', 'ZCode · 智谱'), register('zai', 'ZCode · Z.AI')]
  return () => { for (const dispose of disposers) dispose() }
}
