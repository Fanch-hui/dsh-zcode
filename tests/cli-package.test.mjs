import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const execFile = promisify(execFileCallback)

test('published CLI runs with runtime dependencies and no DSH peer packages', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-zcode-package-'))
  const home = join(temp, 'dsh-home')
  const env = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    DSH_HOME: home,
    npm_config_userconfig: join(temp, 'npm-userconfig'),
    npm_config_globalconfig: join(temp, 'npm-globalconfig'),
    npm_config_cache: join(temp, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  const run = (command, args) => execFile(command, args, { cwd: temp, env, timeout: 30_000 })
  const npmCli = process.env.npm_execpath
  const npm = (...args) => npmCli ? run(process.execPath, [npmCli, ...args]) : run('npm', args)
  try {
    await run(process.execPath, [join(root, 'scripts/build-cli.mjs')])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const dependencies = Object.keys(manifest.dependencies)
    const { stdout } = await npm('pack', root, '--ignore-scripts', '--json', '--pack-destination', temp)
    const archives = [join(temp, JSON.parse(stdout)[0].filename)]
    for (const [index, name] of dependencies.entries()) {
      const stage = join(temp, `dependency-${index}`)
      await mkdir(stage)
      await cp(dirname(require.resolve(`${name}/package.json`)), join(stage, 'package'), { recursive: true, dereference: true })
      const archive = join(temp, `dependency-${index}.tgz`)
      await run('tar', ['-czf', archive, '-C', stage, 'package'])
      archives.push(archive)
    }
    await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true }))
    await npm('install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--offline', ...archives)

    const installed = join(temp, 'node_modules', manifest.name)
    await assert.rejects(access(join(temp, 'node_modules/@deepseek-ai')), { code: 'ENOENT' })
    const notices = await readFile(join(installed, 'lib/cli/THIRD_PARTY_LICENSES.txt'), 'utf8')
    assert.match(notices, /@deepseek-ai\/cordis@/u)
    assert.match(notices, /@deepseek-ai\/dsh-credentials-local@/u)
    const bin = join(installed, manifest.bin['dsh-zcode'])
    const help = await run(process.execPath, [bin, '--help'])
    assert.match(help.stdout, /用法.*dsh-zcode/u)
    assert.equal(help.stderr, '')
    const status = await run(process.execPath, [bin, 'status', '--home', home])
    assert.match(status.stdout, /未登录/u)
    assert.equal(status.stderr, '')
    const disconnect = await run(process.execPath, [bin, 'disconnect', '--home', home])
    assert.match(disconnect.stdout, /已断开连接/u)
    assert.equal(disconnect.stderr, '')
    await access(join(home, '.credentials.yaml'))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
