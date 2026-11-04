import type { AuthPort, Plan, Platform, QuotaSnapshot } from '../types.js'
import { accountState, login } from './login.js'

type CliAction = 'login' | 'status' | 'quota' | 'disconnect' | 'help'
export interface CliArgs { action: CliAction; platform: Platform; plan?: Plan; home?: string }
export interface CliIO { out(value: string): void; error(value: string): void }
export interface CliEnvironment { auth: AuthPort; close(): Promise<void> }

const USAGE = '用法：dsh-zcode <login|status|quota|disconnect> [--platform bigmodel|zai] [--plan coding-plan|start-plan] [--home DSH目录]'

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
  if (quota.unavailable || quota.windows.length === 0) return '平台暂未提供用量信息。'
  const windows = quota.windows.map(item => {
    const amount = item.remaining !== undefined ? `剩余 ${item.remaining}${item.limit !== undefined ? ` / ${item.limit}` : ''}`
      : item.usedPercent !== undefined ? `已用 ${item.usedPercent}%` : '未提供'
    const reset = item.resetsAt === undefined ? '' : `，重置于 ${new Date(item.resetsAt).toLocaleString()}`
    return `${item.name}：${amount}${reset}`
  })
  return [...windows, `更新于 ${new Date(quota.updatedAt).toLocaleString()}`].join('\n')
}

export async function runCli(
  args: readonly string[], io: CliIO, signal: AbortSignal,
  open: (home?: string) => Promise<CliEnvironment>,
): Promise<number> {
  let command: CliArgs
  try { command = parseArgs(args) }
  catch { io.error(USAGE); return 2 }
  if (command.action === 'help') { io.out(USAGE); return 0 }
  let environment: CliEnvironment | undefined
  try {
    signal.throwIfAborted()
    environment = await open(command.home)
    signal.throwIfAborted()
    const { auth } = environment
    if (command.action === 'login') {
      await login(auth, command.platform, signal, url => io.out(`请在浏览器打开授权地址：\n${url}\n按 Ctrl+C 取消登录。`))
      io.out('登录成功。')
    } else if (command.action === 'status') {
      io.out(accountState(await auth.status(command.platform, command.plan)))
    } else if (command.action === 'quota') {
      const account = await auth.snapshot(command.platform, signal, command.plan)
      io.out(quotaText(await auth.queryQuota(account, signal, true)))
    } else {
      await auth.disconnect(command.platform)
      io.out('已断开连接。')
    }
    return 0
  } catch {
    if (signal.aborted) { io.error('操作已取消。'); return 130 }
    io.error('ZCode 操作未完成，请检查连接、授权和套餐状态。')
    return 1
  } finally {
    await environment?.close()
  }
}
