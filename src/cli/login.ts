import type { AccountStatus, AuthPort, Platform } from '../types.js'

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
    signed_out: '未登录', authorizing: '等待浏览器授权', ready: '已连接',
    reauth_required: '登录已失效，请重新登录', quota_exhausted: '套餐额度已用尽', error: '连接异常',
  }
  return `${account.platform === 'bigmodel' ? '智谱 BigModel' : 'Z.AI'}：${states[account.state]}`
}
