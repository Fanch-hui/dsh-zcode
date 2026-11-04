import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const workerFile = join(root, 'lib/proxy/upstream.cjs')
const fixtureFile = join(root, 'tests/helpers/upstream-fake.cjs')
const tempRoot = join(root, '.local/zcode-proxy-build')
const system = JSON.parse(readFileSync(join(root, 'vendor/zcode-api/src/proxy/zcode_system.json'), 'utf8'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function spawnWorker(configPath, options = {}) {
  const syntheticHome = join(configPath, '..', 'home')
  mkdirSync(syntheticHome)
  const child = fork(workerFile, [], {
    execArgv: ['--require', fixtureFile],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: syntheticHome,
      TEST_REAL_HOME: homedir(),
      TEST_PROJECT_ROOT: root.replace(/\/$/, ''),
      ...(options.modelPort ? { TEST_MODEL_PORT: String(options.modelPort) } : {}),
      ...(options.quotaFailure ? { TEST_QUOTA_FAILURE: '1' } : {}),
    },
  })
  const pending = new Map()
  const events = []
  let nextId = 0
  child.on('message', message => {
    if (message.fixture) { events.push(message.fixture); return }
    const operation = pending.get(message.id)
    if (!operation) return
    pending.delete(message.id)
    if (message.error) operation.reject(Object.assign(new Error('worker failed'), message.error))
    else operation.resolve(message.result)
  })
  child.on('exit', () => {
    for (const operation of pending.values()) operation.reject(new Error('worker exited'))
    pending.clear()
  })
  function call(method, params = {}) {
    const id = String(++nextId)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.send({ id, method, params }, error => { if (error) { pending.delete(id); reject(error) } })
    })
  }
  return {
    child, call, events,
    init: platform => call('init', { platform, deviceId: 'fixture-device', apiKey: 'fixture-proxy-key', configPath }),
  }
}

async function startFakeModel() {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture-message","type":"message","role":"assistant","content":[],"model":"glm-5.3","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, requests, port: server.address().port }
}

test('upstream worker keeps account state isolated and passes a synthetic stream through the original proxy', { timeout: 15_000 }, async () => {
  mkdirSync(tempRoot, { recursive: true })
  const directory = mkdtempSync(join(tempRoot, 'ipc-fixture-'))
  const configPath = join(directory, 'config.json')
  const fake = await startFakeModel()
  const worker = spawnWorker(configPath, { modelPort: fake.port })
  try {
    assert.deepEqual(await worker.init('zai'), {
      version: '4.8.8.android', revision: '158e7653b738cbed0996243eeabd26f816638e81',
    })
    const configText = readFileSync(configPath, 'utf8')
    assert.ok(!configText.includes('fixture-proxy-key'))
    const config = JSON.parse(configText)
    assert.deepEqual(config.mcp, { enabled: false, webSearch: false, webReader: false, zread: false, gateway: { enabled: false } })
    assert.equal(config.claim.enabled, false)
    assert.equal(config.claim.auto, false)
    assert.equal(config.responses.enabled, false)
    assert.equal(config.async.enabled, false)

    const first = await worker.call('beginLogin')
    assert.match(first.authorizeUrl, /^https:\/\/login\.example\.test\//)
    assert.ok(first.expiresAt > Date.now() && first.expiresAt <= Date.now() + 180_000)
    const credential = await worker.call('completeLogin', { attemptId: first.attemptId })
    assert.deepEqual(credential, {
      apiKey: 'fixture-key', secret: 'fixture-secret', provider: 'zai', userId: 'fixture-user', jwt: 'fixture.jwt.token',
    })

    const snapshot = await worker.call('quota', { credential, plan: 'start-plan' })
    assert.equal(snapshot.balances[0].remainingUnits, 9)
    assert.equal(snapshot.codingPlan.limits[0].remaining, 9)
    assert.deepEqual(snapshot.errors, [])
    await assert.rejects(worker.call('resolve', { accessToken: 'fixture-fail' }), { code: 'UPSTREAM_FAILED' })

    const { url } = await worker.call('start', { plan: 'start-plan', credential })
    assert.equal(new URL(url).hostname, '127.0.0.1')
    assert.ok(Number(new URL(url).port) > 0)
    assert.deepEqual(await worker.call('start', { plan: 'start-plan', credential }), { url })
    await assert.rejects(worker.call('start', { plan: 'start-plan', credential: { ...credential, jwt: 'other-fixture' } }), { code: 'UPSTREAM_FAILED' })
    assert.equal((await fetch(`${url}/health`)).status, 401)
    const headers = { authorization: 'Bearer fixture-proxy-key', 'content-type': 'application/json' }
    assert.equal((await fetch(`${url}/health`, { headers })).status, 200)
    assert.equal((await fetch(`${url}/quota`, { headers })).status, 200)
    for (const route of ['/mcp', '/v1/responses', '/async/v1/messages']) {
      assert.equal((await fetch(`${url}${route}`, { method: 'POST', headers, body: '{}' })).status, 404)
    }

    const request = {
      model: 'glm-5.3', max_tokens: 128, stream: true, system: 'DSH fixture system',
      messages: [
        { role: 'user', content: 'fixture question' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture-tool-id', name: 'fixture_tool', input: { value: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-tool-id', content: 'fixture result' }] },
      ],
      tools: [{ name: 'fixture_tool', description: 'fixture tool', input_schema: { type: 'object', properties: { value: { type: 'number' } } } }],
    }
    const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(request) })
    const stream = await response.text()
    assert.equal(response.status, 200, stream)
    assert.match(stream, /fixture-message/)
    assert.match(stream, /message_stop/)
    assert.equal(fake.requests.length, 1)
    const wire = fake.requests[0]
    assert.equal(wire.path, '/api/v1/zcode-plan/anthropic/v1/messages')
    assert.equal(wire.headers.authorization, 'Bearer fixture.jwt.token')
    assert.equal(wire.headers['x-device-mid'], undefined)
    assert.equal(wire.headers['x-aliyun-captcha-verify-param'], undefined)
    assert.equal(JSON.parse(wire.body.metadata.user_id).device_id, 'fixture-device')
    assert.equal(wire.body.system[0].text, system.cliPrefix)
    assert.equal(wire.body.system[1].text, system.stableSections.join('\n\n'))
    assert.match(wire.body.system[2].text, /DSH fixture system/)
    assert.deepEqual(wire.body.tools, request.tools)
    assert.equal(wire.body.messages[1].content, 'fixture question')
    assert.equal(wire.body.messages[2].content[0].name, 'fixture_tool')
    assert.equal(wire.body.messages[3].content[0].tool_use_id, 'fixture-tool-id')
    assert.deepEqual(worker.events.sort(), ['client-config', 'routing-config'])

    const second = await worker.call('beginLogin')
    const interrupted = worker.call('completeLogin', { attemptId: second.attemptId }).then(value => ({ value }), error => ({ error }))
    await delay(20)
    await worker.call('cancelLogin', { attemptId: second.attemptId })
    assert.equal((await interrupted).error.code, 'UPSTREAM_FAILED')

    const delayedBegin = worker.call('beginLogin').then(value => ({ value }), error => ({ error }))
    await delay(20)
    await worker.call('cancelLogin')
    const newer = await worker.call('beginLogin')
    assert.equal((await delayedBegin).error.code, 'UPSTREAM_FAILED')
    assert.equal((await worker.call('completeLogin', { attemptId: newer.attemptId })).jwt, 'fixture.jwt.token')

    const stopped = once(worker.child, 'exit')
    assert.equal(await worker.call('close'), null)
    assert.equal((await stopped)[0], 0)
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL')
    await new Promise(resolve => fake.server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('quota plane failures remain distinguishable and disconnect stops the worker', { timeout: 10_000 }, async () => {
  mkdirSync(tempRoot, { recursive: true })
  const directory = mkdtempSync(join(tempRoot, 'ipc-fixture-'))
  const worker = spawnWorker(join(directory, 'config.json'), { quotaFailure: true })
  const credential = { provider: 'zai', apiKey: 'fixture-key', secret: 'fixture-secret', jwt: 'fixture.jwt.token' }
  try {
    await worker.init('zai')
    const snapshot = await worker.call('quota', { credential, plan: 'start-plan' })
    assert.deepEqual(snapshot.errors, ['balance: UPSTREAM_FAILED', 'coding: UPSTREAM_FAILED'])
    assert.ok(!JSON.stringify(snapshot).includes('fixture-private-error'))
    await worker.call('start', { credential, plan: 'start-plan' })
    const stopped = once(worker.child, 'exit')
    worker.child.disconnect()
    assert.equal((await stopped)[0], 0)
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})

test('bigmodel login retains the upstream raw OAuth token', { timeout: 10_000 }, async () => {
  mkdirSync(tempRoot, { recursive: true })
  const directory = mkdtempSync(join(tempRoot, 'ipc-fixture-'))
  const worker = spawnWorker(join(directory, 'config.json'))
  try {
    await worker.init('bigmodel')
    const login = await worker.call('beginLogin')
    const credential = await worker.call('completeLogin', { attemptId: login.attemptId })
    assert.equal(credential.provider, 'bigmodel')
    assert.equal(credential.apiKey, 'fixture-key.fixture-secret')
    assert.equal(credential.oauthAccessToken, 'fixture-access')
    assert.equal(credential.jwt, 'fixture.jwt.token')
    const stopped = once(worker.child, 'exit')
    await worker.call('close')
    assert.equal((await stopped)[0], 0)
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})
