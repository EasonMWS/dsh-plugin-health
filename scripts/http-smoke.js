// End-to-end check of the write routes over a real HTTP socket.
//
// This mounts the **real** `registerRepairRoute` / `registerRescueRoute` exactly the way `plugin.js`
// does, and drives them over `node:http`. An earlier version called the handlers directly, which
// bypassed the route's own guard and key check — so three of its "passes" proved nothing. Anything
// that has to hold for the shipped route must be asserted against the shipped registration.
//
// The client is `node:http` rather than `fetch` because `fetch` treats `Host` as a forbidden header,
// which would defeat the very check under test.
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRepairRoute } from '../src/ui/repair-route.js'
import { registerRescueRoute } from '../src/ui/rescue-route.js'
import { statusForRequest } from '../src/ui/status.js'
import { createLiveObserver } from '../src/reliability/live.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-http-check-'))
const profileDir = join(home, 'profiles', 'desktop')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# user comment\n- id: user\n  name: some-plugin\n')
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['some-plugin'] } } }))
const pluginDirectory = join(profileDir, 'node_modules', 'some-plugin')
mkdirSync(pluginDirectory)
writeFileSync(join(pluginDirectory, 'package.json'), JSON.stringify({
  name: 'some-plugin', version: '1.0.0', engines: { dsh: '0.2.1-rc.5' },
}))

const routes = []
const observe = createLiveObserver()
const liveLocation = { home, profile: 'desktop', runtimeVersion: '0.2.1-rc.5' }
let fiberState = 2
const loaderCtx = { get: () => ({ *entries() {
  yield { id: 'user', options: { name: 'some-plugin' }, fiber: {
    state: fiberState, _error: new Error('tool "archive" is already registered'),
  } }
} }) }
const ctx = {
  inject: (_deps, fn) => fn({
    effect: (f) => f(),
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }),
}
const key = registerRepairRoute(ctx, {
  resolveProfile: () => ({ home, profile: 'desktop' }),
  getStatus: (req) => statusForRequest(req, { ...liveLocation, liveReview: observe(loaderCtx, liveLocation) }),
})
registerRescueRoute(ctx, {
  currentProfile: () => ({ home, profile: 'desktop', profileDir, runtimeVersion: '0.2.1-rc.5' }),
  key,
  toolVersion: '2.1.0',
  refreshUpdateImpl: async () => ({
    currentVersion: '2.1.0', latestVersion: '2.1.0', updateAvailable: false, status: 'ok',
  }),
})

const server = createServer((req, res) => {
  const path = String(req.url ?? '').split('?')[0]
  const route = routes.find((candidate) => (candidate.kind === 'exact' ? candidate.path === path : path.startsWith(candidate.path)))
  if (route === undefined) { res.writeHead(404).end('{}'); return }
  route.handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('{}') })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const authority = `127.0.0.1:${port}`

/**
 * @param {string} path
 * @param {{method?: string, headers?: Record<string,string>, body?: string}} [options]
 * @returns {Promise<{status: number, body: any, setCookie?: string}>}
 */
function call(path, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ?? (method === 'GET' ? undefined : '{}')
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: authority,
        ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* empty */ }
        resolve({ status: res.statusCode, body: parsed, setCookie: res.headers['set-cookie']?.[0] })
      })
    })
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const cases = []
const check = (name, actual, expected) => cases.push({ name, ok: Object.is(actual, expected), actual, expected })
async function attempt(name, fn) {
  try {
    await fn()
  } catch (error) {
    cases.push({ name, ok: false, actual: `threw: ${error.message}`, expected: 'a response' })
  }
}

const REPAIR = '/plugins/dsh-plugin-health/repair'
const RESCUE = '/plugins/dsh-plugin-health/rescue'
const STATUS = '/plugins/dsh-plugin-health/status'
const SAME_ORIGIN = { origin: `http://${authority}`, 'sec-fetch-site': 'same-origin' }

// --- the browser-side fence -----------------------------------------------------------------
await attempt('cross-origin JSON post', async () => {
  check('cross-origin JSON post',
    (await call(REPAIR, { headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' } })).status, 403)
})
await attempt('text/plain post', async () => {
  check('text/plain post',
    (await call(REPAIR, { headers: { 'content-type': 'text/plain' } })).status, 415)
})
await attempt('same-site sec-fetch post', async () => {
  check('same-site sec-fetch post',
    (await call(REPAIR, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' } })).status, 403)
})
await attempt('chunked body without a content type', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: `${RESCUE}/undo`,
      method: 'POST',
      headers: { host: authority, 'transfer-encoding': 'chunked', 'x-plugin-health-key': key },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.write('{"a":1}')
    req.end()
  })
  check('chunked body without a content type', status, 415)
})

// --- the control key, against the real rescue route ------------------------------------------
await attempt('rescue without a key', async () => {
  check('rescue without a key',
    (await call(`${RESCUE}/undo`, { headers: { 'content-type': 'application/json' } })).status, 401)
})
await attempt('rescue with a wrong key', async () => {
  check('rescue with a wrong key',
    (await call(`${RESCUE}/undo`, { headers: { 'content-type': 'application/json', 'x-plugin-health-key': 'nope' } })).status, 401)
})
await attempt('cross-origin rescue', async () => {
  check('cross-origin rescue',
    (await call(`${RESCUE}/undo`, {
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000', 'x-plugin-health-key': key },
    })).status, 403)
})
await attempt('text/plain rescue', async () => {
  check('text/plain rescue',
    (await call(`${RESCUE}/undo`, { headers: { 'content-type': 'text/plain', 'x-plugin-health-key': key } })).status, 415)
})

// --- the legitimate paths still work ----------------------------------------------------------
await attempt('same-origin status', async () => {
  const response = await call(STATUS, { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } })
  check('same-origin status', response.status, 200)
  check('status delivers the cookie',
    typeof response.setCookie === 'string' && response.setCookie.includes('plugin_health_key='), true)
  // The key also has to be readable from the body: that is the path the page uses when the host
  // does not carry Set-Cookie through to it.
  check('status hands the key to the page it served', typeof response.body?.key === 'string' && response.body.key.length > 0, true)
})
await attempt('cross-site status', async () => {
  const response = await call(STATUS, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  check('cross-site status request', response.status, 403)
  check('cross-site status sets no cookie', response.setCookie, undefined)
})
await attempt('preview target version over the status route', async () => {
  const response = await call(`${STATUS}?target=0.2.1-rc.6`, { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } })
  const report = response.body?.review
  check('preview uses the requested DSH version', report?.targetVersion, '0.2.1-rc.6')
  check('preview returns the actual declaration mismatch', report?.packages[0]?.declaration.state, 'incompatible')
  const current = await call(STATUS, { method: 'GET' })
  check('preview does not change the current status', current.body?.review?.packages[0]?.declaration.state, 'compatible')
})
await attempt('live activation changes over the status route', async () => {
  const before = await call(STATUS, { method: 'GET' })
  fiberState = 3
  const failed = await call(STATUS, { method: 'GET' })
  check('live state refreshes independently from disk cache', failed.body?.generatedAt, before.body?.generatedAt)
  check('host registration conflict surfaces through status', failed.body?.liveReview?.entries[0]?.diagnostic?.tool, 'archive')
  check('failure is captured as an observed transition', failed.body?.liveReview?.changes[0]?.after, 'failed')
  fiberState = 2
  const recovered = await call(STATUS, { method: 'GET' })
  check('recovered activation replaces the failure', recovered.body?.liveReview?.entries[0]?.state, 'active')
})
await attempt('same-origin rescue with the key', async () => {
  const response = await call(`${RESCUE}/undo`, {
    headers: { 'content-type': 'application/json', ...SAME_ORIGIN, 'x-plugin-health-key': key },
    body: '{}',
  })
  check('same-origin rescue with the key', response.status, 200)
})
await attempt('rescue through the cookie the browser actually uses', async () => {
  const response = await call(`${RESCUE}/undo`, {
    headers: { 'content-type': 'application/json', ...SAME_ORIGIN, cookie: `plugin_health_key=${key}` },
    body: '{}',
  })
  check('rescue via cookie', response.status, 200)
})
await attempt('a write authorised by the header the page read from /status', async () => {
  // No cookie at all: exactly the situation that produced a permanent 401 in the real app.
  const status = await call(STATUS, { method: 'GET' })
  const fromBody = status.body?.key
  check('the status body carries a key', typeof fromBody === 'string', true)
  const response = await call(`${RESCUE}/undo`, {
    headers: { 'content-type': 'application/json', ...SAME_ORIGIN, 'x-plugin-health-key': fromBody },
    body: '{}',
  })
  check('a write with the body key and no cookie', response.status, 200)
})

await attempt('same-origin keyed repair', async () => {
  const response = await call(REPAIR, {
    headers: { 'content-type': 'application/json', ...SAME_ORIGIN, 'x-plugin-health-key': key },
    body: JSON.stringify({ dryRun: true }),
  })
  check('same-origin keyed repair', response.status, 200)
  check('the repair handler actually ran', response.body?.dryRun, true)
})

await attempt('repair confirmation stays bound to its preview', async () => {
  const headers = { 'content-type': 'application/json', ...SAME_ORIGIN, 'x-plugin-health-key': key }
  const first = join(profileDir, 'package.json.bak-first')
  const second = join(profileDir, 'package.json.bak-second')
  writeFileSync(first, '{}')
  const missing = await call(REPAIR, { headers, body: JSON.stringify({ dryRun: false }) })
  check('repair requires a preview token', missing.status, 409)
  const preview = await call(REPAIR, { headers, body: JSON.stringify({ dryRun: true }) })
  check('repair preview returns a token', typeof preview.body.planToken, 'string')
  writeFileSync(second, '{}')
  const stale = await call(REPAIR, { headers, body: JSON.stringify({ dryRun: false, planToken: preview.body.planToken }) })
  check('repair refuses a newly appearing target', stale.status, 409)
  check('stale preview leaves both files alone', existsSync(first) && existsSync(second), true)
  const current = await call(REPAIR, { headers, body: JSON.stringify({ dryRun: true }) })
  const body = JSON.stringify({ dryRun: false, planToken: current.body.planToken })
  check('fresh repair confirmation succeeds', (await call(REPAIR, { headers, body })).status, 200)
  check('confirmed repair quarantines the previewed files', !existsSync(first) && !existsSync(second), true)
  check('repair preview token cannot be reused', (await call(REPAIR, { headers, body })).status, 409)
})

await attempt('status checks Origin without Fetch Metadata', async () => {
  check('cross-origin status read is refused',
    (await call(STATUS, { method: 'GET', headers: { origin: 'http://127.0.0.1:3000' } })).status, 403)
})

await attempt('rescue excludes inherited actions', async () => {
  check('Object constructor is not a rescue action', (await call(`${RESCUE}/constructor`, {
    headers: { 'content-type': 'application/json', ...SAME_ORIGIN, 'x-plugin-health-key': key },
  })).status, 404)
})

server.closeAllConnections?.()
server.close()
rmSync(home, { recursive: true, force: true })

let failed = 0
for (const item of cases) {
  if (!item.ok) failed += 1
  console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : ` (got ${JSON.stringify(item.actual)}, expected ${JSON.stringify(item.expected)})`}`)
}
console.log(`\n  ${cases.length - failed}/${cases.length} passed over real HTTP, against the real route registration`)
process.exit(failed === 0 ? 0 : 1)
