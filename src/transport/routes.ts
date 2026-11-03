import type { AccountSnapshot } from '../types.js'

const endpoints = {
  bigmodel: {
    oauth: 'https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages',
    'api-key': 'https://open.bigmodel.cn/api/anthropic/v1/messages',
  },
  zai: {
    oauth: 'https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages',
    'api-key': 'https://api.z.ai/api/anthropic/v1/messages',
  },
} as const

export function modelEndpoint(account: AccountSnapshot): string {
  return endpoints[account.platform][account.mode]
}
