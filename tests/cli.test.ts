import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { ZcodeAuth } from '../src/auth/index.js'
import { registerAuthorizationFlows } from '../src/cli/authorization.js'
import { parseArgs, runCli } from '../src/cli/commands.js'
import { DshCredentialStore } from '../src/storage/credentials.js'
import type { UpstreamPort } from '../src/proxy/types.js'

async function fixture(rpc: (method: string, params?: unknown, signal?: AbortSignal) => Promise<unknown>) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-zcode-cli-test-'))
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  const engine = {
    apiKey: 'synthetic-local-key',
    rpc: <T>(method: string, params?: unknown, signal?: AbortSignal) => rpc(method, params, signal) as Promise<T>,
    start: async () => 'http://127.0.0.1:12345/v1/messages', dispose() {},
  }
  const upstream: UpstreamPort = { get: () => engine, release() {}, invalidate() {}, dispose() {} }
  const auth = new ZcodeAuth({ store: new DshCredentialStore(ctx.credentials), upstream })
  let closed = false
  return {
    ctx, auth, home,
    open: async () => ({ auth, close: async () => { closed = true } }),
    get closed() { return closed },
    async dispose() { auth.dispose(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) },
  }
}

test('CLI validates actions before opening the credential service', async () => {
  assert.deepEqual(parseArgs(['quota', '--platform', 'zai', '--home', '/synthetic/dsh']), {
    action: 'quota', platform: 'zai', home: '/synthetic/dsh',
  })
  assert.deepEqual(parseArgs(['quota', '--platform', 'zai', '--plan', 'start-plan']), {
    action: 'quota', platform: 'zai', plan: 'start-plan',
  })
  assert.throws(() => parseArgs(['status', '--plan', 'unknown']), /ZCODE_CLI_USAGE/)
  let opened = false
  const errors: string[] = []
  const code = await runCli(['login', '--platform', 'unknown'], { out() {}, error: value => errors.push(value) },
    new AbortController().signal, async () => { opened = true; throw new Error('unexpected') })
  assert.equal(code, 2)
  assert.equal(opened, false)
  assert.match(errors[0], /用法/u)
})

test('CLI executable starts and exits with an isolated official credential provider', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-zcode-bin-test-'))
  try {
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/bin.ts', 'status', '--home', home], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
      child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout, stderr }))
    })
    assert.equal(output.code, 0)
    assert.match(output.stdout, /未登录/u)
    assert.equal(output.stderr, '')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('DSH authorization flow notifies its caller and confirms the actual credential commit', async () => {
  const now = Date.now()
  const item = await fixture(async method => {
    if (method === 'beginLogin') return { attemptId: 'fixture', authorizeUrl: 'https://bigmodel.cn/login?flow=fixture', expiresAt: now + 60_000 }
    if (method === 'completeLogin') return { provider: 'bigmodel', apiKey: 'synthetic-key', jwt: 'synthetic-zcode' }
    if (method === 'cancelLogin') return null
    throw new Error('unexpected method')
  })
  try {
    await item.ctx.plugin(AuthorizationService)
    const dispose = registerAuthorizationFlows(item.ctx, item.auth)
    const notices: string[] = []
    const result = await item.ctx.authorization.begin({ key: credentialKey('llm-zcode', 'bigmodel'),
      interaction: { notify: notice => notices.push(notice.url ?? ''), prompt: async () => { throw new Error('unexpected') } } })
    assert.equal(result.status, 'authorized')
    assert.deepEqual(notices, ['https://bigmodel.cn/login?flow=fixture'])
    assert.equal((await item.ctx.credentials.describeRecord(credentialKey('llm-zcode', 'bigmodel'))).configured, true)
    dispose()
  } finally { await item.dispose() }
})

test('CLI login can be cancelled while initialization waits for the network', async () => {
  let initiated!: () => void
  const started = new Promise<void>(resolve => { initiated = resolve })
  const item = await fixture(async (method, _params, signal) => {
    if (method === 'cancelLogin') return null
    initiated()
    return await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  })
  try {
    const messages: string[] = []
    const controller = new AbortController()
    const running = runCli(['login'], { out: value => messages.push(value), error: value => messages.push(value) }, controller.signal, item.open)
    await started
    controller.abort()
    assert.equal(await running, 130)
    assert.equal(item.closed, true)
    assert.deepEqual(messages, ['操作已取消。'])
    assert.equal((await item.auth.status('bigmodel')).state, 'signed_out')
  } finally { await item.dispose() }
})

test('CLI status, quota, and disconnect use the same DSH credential record', async () => {
  const item = await fixture(async method => {
    if (method === 'quota') return { serverTime: Date.now(), balances: [], errors: [],
      codingPlan: { level: 'fixture', limits: [{ type: 'TOKENS_LIMIT', total: 100, remaining: 80, used: 20 }] } }
    if (method === 'cancelLogin') return null
    throw new Error('unexpected method')
  })
  try {
    await item.auth.useApiKey('bigmodel', 'synthetic-test-key')
    const messages: string[] = []
    const io = { out: (value: string) => messages.push(value), error: (value: string) => messages.push(value) }
    const signal = new AbortController().signal
    assert.equal(await runCli(['status'], io, signal, item.open), 0)
    assert.match(messages.pop()!, /已连接/u)
    assert.equal(await runCli(['quota'], io, signal, item.open), 0)
    const quota = messages.pop()!
    assert.match(quota, /剩余 80 \/ 100/u)
    assert.doesNotMatch(quota, /synthetic-test-key/u)
    assert.equal(await runCli(['disconnect'], io, signal, item.open), 0)
    assert.equal((await item.auth.status('bigmodel')).state, 'signed_out')
  } finally { await item.dispose() }
})
