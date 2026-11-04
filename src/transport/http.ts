import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountSnapshot, AuthPort, RequestCredential } from '../types.js'

export function retryAfter(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86_400_000) : undefined
}

export function httpFailure(response: Response, account: AccountSnapshot,
  credential: RequestCredential, auth: AuthPort, delay?: number): LlmError {
  const status = response.status
  if (status === 401) {
    if (credential.kind === 'pat') {
      auth.reject(account, credential)
      return new LlmError('ZCode 短期凭据已失效，请重试当前步骤。', 'ZCODE_PAT_REJECTED', { status })
    }
    auth.markState(account, 'reauth_required', 'AUTH')
    return new LlmError('套餐 Key 已失效，请更新插件凭据后继续。', 'AUTH', { status })
  }
  if (status === 403) return new LlmError('平台拒绝访问，请检查套餐权益与接入权限。', 'PERMISSION', { status })
  if (status === 429) return new LlmError('平台请求受限，正在等待冷却。', 'RATE_LIMIT', {
    status, ...(delay ? { providerRetryAfterMs: delay } : {}),
  })
  if (status === 402) {
    auth.markState(account, 'quota_exhausted', 'QUOTA_EXHAUSTED')
    return new LlmError('套餐额度已用尽，请刷新用量查看重置时间。', 'QUOTA_EXHAUSTED', { status })
  }
  if (status === 404) return new LlmError('平台未提供所选模型，请刷新目录后选择。', 'MODEL_NOT_FOUND', { status })
  if (status >= 500) return new LlmError('ZCode 服务暂时不可用，请重试当前步骤。', 'SERVER', { status })
  return new LlmError('平台拒绝此模型请求，请检查模型与配置。', 'INVALID_REQUEST', { status })
}
