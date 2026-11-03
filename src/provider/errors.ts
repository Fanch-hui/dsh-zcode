import { LlmError } from '@deepseek-ai/dsh-llm'
import { AuthError } from '../auth/http.js'

export function providerFailure(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof AuthError) {
    if (/ACCOUNT_CHANGED|DISPOSED|CANCELLED/.test(error.code)) return new LlmError('ZCode 连接已变更，请重新发起当前任务。', 'ABORTED')
    if (error.status === 401 || /LOGIN_REQUIRED|CREDENTIAL_INVALID|API_KEY_REJECTED/.test(error.code)) {
      return new LlmError('ZCode 登录已失效，请重新登录后继续。', 'AUTH')
    }
    if (error.status === 403 || /DISABLED|PROJECT_UNAVAILABLE/.test(error.code)) {
      return new LlmError('平台接入或套餐权限未就绪，请检查账号权益。', 'PERMISSION')
    }
    if (error.status === 429) return new LlmError('平台请求受限，请稍后重试。', 'RATE_LIMIT')
    if (error.status && error.status >= 500) return new LlmError('平台认证服务暂时不可用，请重试。', 'SERVER')
    if (error.code.endsWith('_TIMEOUT')) return new LlmError('ZCode 认证请求超时，请重试。', 'TIMEOUT')
    if (error.code.endsWith('_NETWORK')) return new LlmError('ZCode 网络连接失败，请重试。', 'TRANSPORT')
    return new LlmError('ZCode 认证未完成，请在插件设置页检查连接。', error.code)
  }
  return new LlmError('ZCode 网络请求失败，请重试当前步骤。', 'TRANSPORT')
}
