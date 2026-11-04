import { createHash, randomUUID } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AccountSnapshot } from '../types.js'

export function upstreamSession(scope: string, account: AccountSnapshot, options: GenerateOptions<string>): string {
  return createHash('sha256').update(JSON.stringify([
    scope, account.platform, account.scope, account.plan ?? 'coding-plan', options.model,
    options.sessionId ?? randomUUID(), options.purpose ?? 'conversation',
  ])).digest('hex')
}
