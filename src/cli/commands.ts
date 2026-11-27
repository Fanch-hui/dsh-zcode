import type { AuthPort, Plan, Platform, QuotaSnapshot } from '../types.js'
import { t } from '../i18n/index.js'
import { accountState, login } from './login.js'

type CliAction = 'login' | 'status' | 'quota' | 'disconnect' | 'help'
export interface CliArgs { action: CliAction; platform: Platform; plan?: Plan; home?: string }
export interface CliIO { out(value: string): void; error(value: string): void }
export interface CliEnvironment { auth: AuthPort; close(): Promise<void> }


export function parseArgs(args: readonly string[]): CliArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { action: 'help', platform: 'bigmodel' }
  const action = args[0]
  if (action !== 'login' && action !== 'status' && action !== 'quota' && action !== 'disconnect') throw new Error('ZCODE_CLI_USAGE')
  let platform: Platform = 'bigmodel'
  let plan: Plan | undefined
  let home: string | undefined
  const seen = new Set<string>()
  for (let index = 1; index < args.length; index++) {
    const option = args[index]
    const value = args[++index]
    if ((option !== '--platform' && option !== '--home' && option !== '--plan') || !value || seen.has(option)) throw new Error('ZCODE_CLI_USAGE')
    seen.add(option)
    if (option === '--platform') {
      if (value !== 'bigmodel' && value !== 'zai') throw new Error('ZCODE_CLI_USAGE')
      platform = value
    } else if (option === '--plan') {
      if (value !== 'coding-plan' && value !== 'start-plan') throw new Error('ZCODE_CLI_USAGE')
      plan = value
    } else home = value
  }
  return { action, platform, ...(plan ? { plan } : {}), ...(home === undefined ? {} : { home }) }
}

function quotaText(quota: QuotaSnapshot): string {
  if (quota.unavailable || quota.windows.length === 0) return t('quota.unavailable')
  const windows = quota.windows.map(item => {
    const amount = item.remaining !== undefined ? t('quota.remaining', { value: `${item.remaining}${item.limit !== undefined ? ` / ${item.limit}` : ''}` })
      : item.usedPercent !== undefined ? t('quota.used', { value: item.usedPercent }) : t('quota.notProvided')
    const reset = item.resetsAt === undefined ? '' : t('quota.cliReset', { date: new Date(item.resetsAt).toLocaleString() })
    return `${item.name}：${amount}${reset}`
  })
  return [...windows, t('quota.updatedAt', { date: new Date(quota.updatedAt).toLocaleString() })].join('\n')
}

export async function runCli(
  args: readonly string[], io: CliIO, signal: AbortSignal,
  open: (home?: string) => Promise<CliEnvironment>,
): Promise<number> {
  let command: CliArgs
  try { command = parseArgs(args) }
  catch { io.error(t('cli.usage')); return 2 }
  if (command.action === 'help') { io.out(t('cli.usage')); return 0 }
  let environment: CliEnvironment | undefined
  try {
    signal.throwIfAborted()
    environment = await open(command.home)
    signal.throwIfAborted()
    const { auth } = environment
    if (command.action === 'login') {
      await login(auth, command.platform, signal, url => io.out(t('cli.loginPrompt', { url })))
      io.out(t('cli.loginSuccess'))
    } else if (command.action === 'status') {
      io.out(accountState(await auth.status(command.platform, command.plan)))
    } else if (command.action === 'quota') {
      const account = await auth.snapshot(command.platform, signal, command.plan)
      io.out(quotaText(await auth.queryQuota(account, signal, true)))
    } else {
      await auth.disconnect(command.platform)
      io.out(t('cli.disconnected'))
    }
    return 0
  } catch {
    if (signal.aborted) { io.error(t('cli.cancelled')); return 130 }
    io.error(t('cli.failed'))
    return 1
  } finally {
    await environment?.close()
  }
}
