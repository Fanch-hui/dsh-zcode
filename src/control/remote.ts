import { z } from 'zod'
import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type { ControlOperations, ZCodeStatus } from './types.js'

export const REMOTE_PACKAGE = 'dsh-zcode'
export const REMOTE_NAMESPACE = 'zcode'

const platformSchema = z.enum(['bigmodel', 'zai'])
const planSchema = z.enum(['coding-plan', 'start-plan'])
const identifier = z.string().min(1).max(512)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const accountSchema = z.strictObject({
  platform: platformSchema,
  plan: planSchema.optional(),
  state: z.enum(['signed_out', 'authorizing', 'ready', 'reauth_required', 'quota_exhausted', 'error']),
  authMode: z.enum(['oauth', 'api-key']).optional(),
  accountLabel: z.string().max(512).optional(),
  scope: identifier.optional(),
  generation: timestamp,
  login: z.strictObject({ attemptId: identifier, authorizeUrl: z.string().url().max(4096), expiresAt: timestamp }).optional(),
  errorCode: identifier.optional(),
})
const quotaSchema = z.strictObject({
  updatedAt: timestamp,
  windows: z.array(z.strictObject({
    name: identifier, usedPercent: z.number().finite().nonnegative().optional(),
    remaining: z.number().finite().nonnegative().optional(), limit: z.number().finite().nonnegative().optional(),
    resetsAt: timestamp.optional(), unit: z.string().max(128).optional(),
  })).max(128),
  unavailable: z.boolean().optional(),
})
export const statusSchema: z.ZodType<ZCodeStatus> = z.strictObject({
  accounts: z.array(accountSchema).max(4),
  settings: z.strictObject({
    platform: platformSchema, plan: planSchema.optional(), concurrency: z.number().int().min(1).max(8),
    maxTokens: z.number().int().min(1).max(128000), timeoutMs: z.number().int().min(10000).max(1800000),
    effort: z.enum(['low', 'high', 'max']),
  }),
  models: z.array(z.strictObject({ provider: identifier, id: identifier, name: identifier })).max(256),
  quotas: z.array(z.strictObject({ platform: platformSchema, plan: planSchema.optional(), snapshot: quotaSchema.optional(), errorCode: identifier.optional() })).max(4),
})
export const keyInputSchema = z.strictObject({ platform: platformSchema, key: z.string().min(1).max(4096) })

function codec<Value>(typeSymbol: string, schema: z.ZodType<Value>): TypertCodec<Value> {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

function method(name: keyof ControlOperations, ...parameters: { name: string; codec: TypertCodec; optional?: true }[]): InvocationDescriptor {
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${name}`,
    service: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE, method: name,
    invocation: { kind: 'direct' },
    parameters: parameters.map(parameter => ({
      name: parameter.name, wire: parameter.name, source: 'json' as const, codec: parameter.codec,
      ...(parameter.optional ? { acceptsUndefined: true as const } : {}),
    })),
    result: codec('ZCodeStatus', statusSchema),
  }
}

const platform = { name: 'platform', codec: codec('ZCodePlatform', platformSchema) }
const plan = { name: 'plan', codec: codec('ZCodePlan', planSchema), optional: true as const }
const descriptors: readonly InvocationDescriptor[] = [
  method('status'), method('beginLogin', platform), method('cancelLogin', platform), method('disconnect', platform),
  method('useApiKey', { name: 'input', codec: codec('ZCodeKeyInput', keyInputSchema) }),
  method('refreshModels', platform, plan), method('readQuota', platform, plan), method('refreshQuota', platform, plan),
]

export const remoteContribution: TypertRemoteContribution = { package: REMOTE_PACKAGE, descriptors }
export const contribution = remoteContribution
export const TYPERT: TypertContribution = {
  package: REMOTE_PACKAGE, face: 'host',
  schemas: [{ name: 'ZCodeStatus', create: () => statusSchema }],
  model: { services: [], events: [], objects: [] }, invocations: descriptors,
}
