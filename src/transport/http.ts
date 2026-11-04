import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountSnapshot, AuthPort, RequestCredential } from '../types.js'
import { readBoundedJson } from './json.js'

export function retryAfter(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86_400_000) : undefined
}

const quotaLimits: Readonly<Record<string, string>> = {
  '1113': '平台余额不足或没有可用资源包，请检查套餐状态。',
  '1308': '套餐当前用量窗口额度已用尽，请刷新用量查看重置时间。',
  '1310': '套餐本周或本月额度已用尽，请刷新用量查看重置时间。',
  '1316': '套餐近 5 小时额度已用尽，额外用量余额不足，请刷新用量查看重置时间。',
  '1317': '套餐近 7 天额度已用尽，额外用量余额不足，请刷新用量查看重置时间。',
  '1318': '套餐近 5 小时额度已用尽，额外用量已达费用上限，请刷新用量查看重置时间。',
  '1319': '套餐近 7 天额度已用尽，额外用量已达费用上限，请刷新用量查看重置时间。',
  '1320': '套餐近 5 小时额度已用尽，额外用量已达费用上限，请刷新用量查看重置时间。',
  '1321': '套餐近 7 天额度已用尽，额外用量已达费用上限，请刷新用量查看重置时间。',
}

const permissionLimits: Readonly<Record<string, string>> = {
  '1309': 'Coding Plan 套餐已到期，请检查平台订阅状态。',
  '1311': '当前套餐未包含所选模型，请选择套餐支持的模型。',
  '1313': '平台按使用规则限制了该账号的请求，请在平台检查使用限制。',
  '1314': '企业套餐已到期，请联系套餐管理员。',
  '1315': '当前凭据的套餐类型与该请求不匹配，请检查平台套餐配置。',
}

const transientLimits: Readonly<Record<string, string>> = {
  '1302': '请求频率达到平台限制，请稍后重试。',
  '1305': '模型服务暂时繁忙，请稍后重试。',
}

export async function httpFailure(response: Response, account: AccountSnapshot,
  credential: RequestCredential, auth: Pick<AuthPort, 'reject' | 'markState'>, delay?: number): Promise<LlmError> {
  const status = response.status
  if (status === 429) {
    const code = await readProviderCode(response)
    const label = account.platform === 'zai' ? 'Z.AI' : '智谱'
    const detail = code ? `（平台码 ${code}）` : '（HTTP 429）'
    if (code && quotaLimits[code]) {
      auth.markState(account, 'quota_exhausted', 'QUOTA_EXHAUSTED')
      return new LlmError(`${label}：${quotaLimits[code]}${detail}`, 'QUOTA_EXHAUSTED', { status })
    }
    if (code && permissionLimits[code]) {
      return new LlmError(`${label}：${permissionLimits[code]}${detail}`, 'PERMISSION', { status })
    }
    const message = transientLimits[code ?? ''] ?? '平台暂时限制了请求，请稍后重试。'
    return new LlmError(`${label}：${message}${detail}`, code === '1305' ? 'SERVER' : 'RATE_LIMIT', {
      status, ...(delay ? { providerRetryAfterMs: delay } : {}),
    })
  }
  await response.body?.cancel()
  if (status === 401) {
    if (credential.kind === 'pat') {
      auth.reject(account, credential)
      return new LlmError('ZCode 短期凭据已失效，请重试当前步骤。', 'ZCODE_PAT_REJECTED', { status })
    }
    auth.markState(account, 'reauth_required', 'AUTH')
    return new LlmError('套餐 Key 已失效，请更新插件凭据后继续。', 'AUTH', { status })
  }
  if (status === 403) return new LlmError('平台拒绝访问，请检查套餐权益与接入权限。', 'PERMISSION', { status })
  if (status === 402) {
    auth.markState(account, 'quota_exhausted', 'QUOTA_EXHAUSTED')
    return new LlmError('套餐额度已用尽，请刷新用量查看重置时间。', 'QUOTA_EXHAUSTED', { status })
  }
  if (status === 404) return new LlmError('平台未提供所选模型，请刷新目录后选择。', 'MODEL_NOT_FOUND', { status })
  if (status >= 500) return new LlmError('ZCode 服务暂时不可用，请重试当前步骤。', 'SERVER', { status })
  return new LlmError('平台拒绝此模型请求，请检查模型与配置。', 'INVALID_REQUEST', { status })
}

async function readProviderCode(response: Response): Promise<string | undefined> {
  let body: unknown
  try {
    body = await readBoundedJson(response, 16_384)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return undefined
    throw error
  }
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined
  const error = body.error
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = String(error.code)
  return /^\d{4}$/.test(code) ? code : undefined
}
