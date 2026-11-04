#!/usr/bin/env node
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ZcodeAuth } from '../auth/index.js'
import { DshCredentialStore } from '../storage/credentials.js'
import { createDeviceId } from '../storage/device.js'
import { UpstreamManager } from '../proxy/manager.js'
import { runCli, type CliEnvironment } from './commands.js'

async function open(home?: string): Promise<CliEnvironment> {
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentialProvider, { ...(home ? { dshHome: home } : {}), watch: true })
    const upstream = new UpstreamManager({ deviceId: createDeviceId(resolveDshHome(home)),
      workerUrl: new URL('../proxy/upstream.cjs', import.meta.url) })
    const auth = new ZcodeAuth({
      store: new DshCredentialStore(ctx.credentials), upstream,
    })
    return {
      auth,
      async close() {
        auth.dispose()
        upstream.dispose()
        await ctx.fiber.dispose()
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

const stop = new AbortController()
const interrupt = () => stop.abort()
process.once('SIGINT', interrupt)
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: value => process.stdout.write(`${value}\n`),
    error: value => process.stderr.write(`${value}\n`),
  }, stop.signal, open)
} finally {
  process.removeListener('SIGINT', interrupt)
}
