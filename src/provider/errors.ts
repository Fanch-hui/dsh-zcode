import { LlmError } from '@deepseek-ai/dsh-llm'
import { t } from '../i18n/index.js'
import { AuthError } from '../auth/http.js'

export function providerFailure(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof AuthError) {
    if (/ACCOUNT_CHANGED|DISPOSED|CANCELLED/.test(error.code)) return new LlmError(t('errors.changed'), 'ABORTED')
    if (error.status === 401 || /LOGIN_REQUIRED|CREDENTIAL_INVALID|API_KEY_REJECTED/.test(error.code)) {
      return new LlmError(t('errors.auth'), 'AUTH')
    }
    if (error.status === 403 || /DISABLED|PROJECT_UNAVAILABLE/.test(error.code)) {
      return new LlmError(t('errors.permission'), 'PERMISSION')
    }
    if (error.status === 429) return new LlmError(t('errors.rateLimit'), 'RATE_LIMIT')
    if (error.status && error.status >= 500) return new LlmError(t('errors.server'), 'SERVER')
    if (error.code.endsWith('_TIMEOUT')) return new LlmError(t('errors.timeout'), 'TIMEOUT')
    if (error.code.endsWith('_NETWORK')) return new LlmError(t('errors.network'), 'TRANSPORT')
    return new LlmError(t('errors.authIncomplete'), error.code)
  }
  return new LlmError(t('errors.networkRequest'), 'TRANSPORT')
}
