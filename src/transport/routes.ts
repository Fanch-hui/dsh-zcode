import type { AccountSnapshot } from '../types.js'

const endpoints = {
  bigmodel: 'https://open.bigmodel.cn/api/anthropic/v1/messages',
  zai: 'https://api.z.ai/api/anthropic/v1/messages',
} as const

export function modelEndpoint(account: AccountSnapshot): string {
  if (account.plan === 'start-plan') return 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'
  return endpoints[account.platform]
}
