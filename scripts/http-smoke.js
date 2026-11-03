// End-to-end check of the write guards against a real HTTP server.
//
// The unit tests call the guard function directly; this starts the real handlers on a socket and
// makes real requests — the only way to know the wiring is right: that the guard runs, that it runs
// before the key check, and that a legitimate same-origin request still reaches its handler.
//
// Uses node:http for the client as well as the server: `fetch` treats `host` as a forbidden header,
// which would defeat the very check under test.
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRepairHandler, createStatusHandler } from '../src/ui/repair-route.js'
import { createRescueHandlers } from '../src/ui/rescue-route.js'

const key = 'k'.repeat(48)
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-http-check-'))
const counters = { undo: 0, repair: 0 }

const repair = createRepairHandler({
  key,
  // The handler reads findings, then applies them and reports actions/skipped/quarantineDir, so the
  // stub has to answer in that shape or the request ends in a 500 for the wrong reason.
  inspect: () => ({ findings: [], home: profileDir, summary: { error: 0, warn: 0 } }),
  apply: async () => {
    counters.repair += 1
    return { actions: [], skipped: [], quarantineDir: null }
  },
  resolveProfile: () => ({ home: profileDir, profile: 'desktop', profileDir }),
})
const status = createStatusHandler(async () => ({ schemaVersion: 4, issues: [] }), key)
const rescue = createRescueHandlers({
  currentProfile: () => ({ home: profileDir, profile: 'desktop', profileDir, runtimeVersion: '0.2.1-rc.5' }),
  dshDirectoryOf: () => '/host/dsh',
  undoImpl: () => { counters.undo += 1; return { undone: 1, remaining: [] } },
})

const server = createServer((req, res) => {
  const route = async () => {
    if (req.url.endsWith('/status')) return status(req, res)
    if (req.url.includes('/rescue/')) {
      const result = await rescue.undo({})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }
    return repair(req, res)
  }
  route().catch((error) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error) }))
  })
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
const check = (name, actual, expected) => cases.push({ name, ok: actual === expected, actual, expected })
/** Run one request, turning a throw or a timeout into a failed case rather than an aborted run. */
async function attempt(name, fn) {
  try {
    await fn()
  } catch (error) {
    cases.push({ name, ok: false, actual: `threw: ${error.message}`, expected: 'a response' })
  }
}

// 1. A cross-origin page forging a simple request is refused before anything happens.
await attempt('cross-origin JSON post', async () => {
  check('cross-origin JSON post', (await call('/plugins/dsh-plugin-health/repair', {
    headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
  })).status, 403)
})

// 2. text/plain is refused: it is a CORS simple request and would skip the preflight.
await attempt('text/plain post', async () => {
  check('text/plain post', (await call('/plugins/dsh-plugin-health/repair', { headers: { 'content-type': 'text/plain' } })).status, 415)
})

// 3. Sec-Fetch-Site cross-site is refused even with no Origin header.
check('same-site sec-fetch post',
  (await call('/plugins/dsh-plugin-health/repair', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' },
  })).status, 403)

// 4. The status route will not seed the cookie for a cross-site request.
const statusCross = await call('/plugins/dsh-plugin-health/status', {
  method: 'GET', headers: { 'sec-fetch-site': 'cross-site' },
})
check('cross-site status request', statusCross.status, 403)
check('cross-site status sets no cookie', statusCross.setCookie, undefined)

// 5. A genuine same-origin request still works end to end.
const okStatus = await call('/plugins/dsh-plugin-health/status', {
  method: 'GET', headers: { 'sec-fetch-site': 'same-origin' },
})
check('same-origin status', okStatus.status, 200)
check('status delivers the cookie',
  typeof okStatus.setCookie === 'string' && okStatus.setCookie.includes('plugin_health_key='), true)

const keyed = await call('/plugins/dsh-plugin-health/repair', {
  headers: {
    'content-type': 'application/json',
    origin: `http://${authority}`,
    'sec-fetch-site': 'same-origin',
    'x-plugin-health-key': key,
  },
  body: JSON.stringify({ dryRun: true }),
})
check('same-origin keyed write', keyed.status, 200)

// 6. A rescue action still reaches its handler from a proper origin.
const rescueCall = await call('/plugins/dsh-plugin-health/rescue/undo', {
  headers: {
    'content-type': 'application/json',
    origin: `http://${authority}`,
    'sec-fetch-site': 'same-origin',
    'x-plugin-health-key': key,
  },
  body: '{}',
})
check('same-origin rescue action', rescueCall.status, 200)
check('rescue handler actually ran', counters.undo, 1)

// 7. The cookie alone is enough — that is the path the browser UI uses.
const viaCookie = await call('/plugins/dsh-plugin-health/rescue/undo', {
  headers: {
    'content-type': 'application/json',
    origin: `http://${authority}`,
    cookie: `plugin_health_key=${key}`,
  },
  body: '{}',
})
check('rescue via cookie', viaCookie.status, 200)

server.closeAllConnections?.()
server.close()
rmSync(profileDir, { recursive: true, force: true })

let failed = 0
for (const item of cases) {
  if (!item.ok) failed += 1
  console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : ` (got ${JSON.stringify(item.actual)}, expected ${JSON.stringify(item.expected)})`}`)
}
console.log(`\n  ${cases.length - failed}/${cases.length} passed over real HTTP`)
process.exit(failed === 0 ? 0 : 1)