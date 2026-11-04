const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const tls = require('node:tls')

const home = os.homedir()
const realHome = process.env.TEST_REAL_HOME
const projectRoot = process.env.TEST_PROJECT_ROOT
function guard(filename) {
  if (typeof filename !== 'string') return
  const resolved = path.resolve(filename)
  if (resolved === home || resolved.startsWith(`${home}/`)) throw new Error('PERSONAL_FILES_BLOCKED')
  if (realHome && (resolved === realHome || resolved.startsWith(`${realHome}/`))
    && !(projectRoot && (resolved === projectRoot || resolved.startsWith(`${projectRoot}/`)))) throw new Error('PERSONAL_FILES_BLOCKED')
}
for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'existsSync', 'stat', 'statSync', 'readdir', 'readdirSync']) {
  const original = fs[name]
  fs[name] = function (filename, ...args) { guard(filename); return original.call(this, filename, ...args) }
}
for (const name of ['readFile', 'open', 'stat', 'readdir']) {
  const original = fs.promises[name]
  fs.promises[name] = function (filename, ...args) { guard(filename); return original.call(this, filename, ...args) }
}
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (options, ...args) {
  const target = Array.isArray(options) ? options[0] : options
  const host = typeof target === 'object' && target ? (target.host ?? target.hostname) : typeof args[0] === 'string' ? args[0] : ''
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('EXTERNAL_NETWORK_BLOCKED')
  return originalConnect.call(this, options, ...args)
}
tls.connect = function (options, callback) {
  if (options.host !== 'zcode.z.ai' || !process.env.TEST_MODEL_PORT) throw new Error('EXTERNAL_NETWORK_BLOCKED')
  return net.connect({ host: '127.0.0.1', port: Number(process.env.TEST_MODEL_PORT) }, callback)
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let loginCount = 0

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.pathname === '/api/v1/client/configs') {
    if (url.searchParams.get('platform') !== `${process.platform}-${process.arch}`) throw new Error('BAD_FIXTURE_PLATFORM')
    process.send?.({ fixture: 'client-config' })
    return json({ data: { configs: { captcha: { enabled: true, skip_model_request: true } } } })
  }
  if (url.pathname === '/api/v1/agent/configs') {
    if (new Headers(init.headers).get('x-device-mid') !== 'fixture-device') throw new Error('BAD_FIXTURE_DEVICE')
    process.send?.({ fixture: 'routing-config' })
    return json({ code: 0, data: { proxyEndpoint: { mapping: [] } } })
  }
  if (url.pathname === '/api/v1/oauth/cli/init') {
    const id = ++loginCount
    const provider = JSON.parse(init.body).provider
    if (id === 3) await delay(150)
    return json({ code: 0, data: {
      flow_id: `fixture-${id}-${provider}`,
      authorize_url: 'https://login.example.test/authorize',
      expires_at: Math.floor(Date.now() / 1000) + 180,
      poll_interval_sec: 1,
    } })
  }
  if (url.pathname.startsWith('/api/v1/oauth/cli/poll/')) {
    const flow = decodeURIComponent(url.pathname.split('/').pop())
    if (flow.startsWith('fixture-2-')) await delay(150)
    const provider = flow.endsWith('-bigmodel') ? 'bigmodel' : 'zai'
    return json({ code: 0, data: {
      status: 'ready', token: 'fixture.jwt.token', user: { user_id: 'fixture-user' },
      [provider]: { access_token: 'fixture-access' },
    } })
  }
  if (url.pathname === '/api/auth/z/login') {
    if (JSON.parse(init.body).token === 'fixture-fail') return json({ message: 'fixture-private-error' }, 403)
    return json({ access_token: 'fixture-biz' })
  }
  if (url.pathname === '/api/biz/customer/getCustomerInfo') {
    return json({ code: 0, data: { organizations: [{ id: 'fixture-org', projects: [{ id: 'fixture-project' }] }] } })
  }
  if (url.pathname.endsWith('/api_keys/copy/fixture-key')) return json({ code: 0, data: { secretKey: 'fixture-secret' } })
  if (url.pathname.endsWith('/api_keys')) return json({ code: 0, data: [{ name: 'zcode-api-key', apiKey: 'fixture-key' }] })
  if (url.pathname === '/api/v1/zcode-plan/billing/balance') {
    if (process.env.TEST_QUOTA_FAILURE === '1') return json(null)
    if (new Headers(init.headers).get('authorization') !== 'Bearer fixture.jwt.token') throw new Error('BAD_FIXTURE_JWT')
    return json({ code: 0, data: { balances: [{ show_name: 'GLM-5.3', remaining_units: 9, total_units: 10, used_units: 1 }] } })
  }
  if (url.pathname === '/api/v1/zcode-plan/billing/preview') return json({ code: 0, data: { plans: [] } })
  if (url.pathname === '/api/monitor/usage/quota/limit') {
    if (process.env.TEST_QUOTA_FAILURE === '1') return json({ code: 42, msg: 'fixture-private-error' })
    if (new Headers(init.headers).get('authorization') !== 'fixture-key.fixture-secret') throw new Error('BAD_FIXTURE_KEY')
    return json({ code: 0, data: { level: 'fixture', limits: [{ type: 'TOKENS_LIMIT', number: 10, remaining: 9 }] } })
  }
  throw new Error('UNEXPECTED_FIXTURE_REQUEST')
}
