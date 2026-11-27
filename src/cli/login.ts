import type { AccountStatus, AuthPort, Platform } from '../types.js'
import { t } from '../i18n/index.js'

type LoginAuth = Pick<AuthPort, 'beginLogin' | 'waitForLogin'>

/** Begin one OAuth attempt and wait until its own credential commit settles. */
export async function login(
  auth: LoginAuth, platform: Platform, signal: AbortSignal, notify: (url: string) => void,
): Promise<void> {
  signal.throwIfAborted()
  const started = await auth.beginLogin(platform, signal)
  if (!started.login) throw new Error('ZCODE_OAUTH_INVALID_RESPONSE')
  notify(started.login.authorizeUrl)
  await auth.waitForLogin(platform, started.login.attemptId, signal)
}

export function accountState(account: AccountStatus): string {
  const states: Record<AccountStatus['state'], string> = {
    signed_out: t('state.signed_out'), authorizing: t('state.authorizing'), ready: t('state.ready'),
    reauth_required: t('state.reauth_required'), quota_exhausted: t('state.quota_exhausted'), error: t('state.errorCli'),
  }
  return t('cli.accountState', { platform: account.platform === 'bigmodel' ? t('platform.bigmodel') : t('platform.zai'), state: states[account.state] })
}
