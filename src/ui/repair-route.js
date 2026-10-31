/**
 * One-click repair endpoint for the browser half.
 *
 * Safety rules, in order:
 * 1. loopback-only Host (same fence as the status route) — a DNS-rebinding page cannot reach it;
 * 2. an in-process random key minted per boot, handed only to the same-origin page — a local
 *    process cannot "prove" it was told the key, so it cannot trigger writes;
 * 3. only findings whose `fix.auto === true` are applied; everything else is reported as manual;
 * 4. repairs never delete: files/directories move to a quarantine directory, the patch rewrite keeps
 *    a backup plus the user's comments.
 * @module ui/repair-route
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { applyRepairs, planRepairs } from '../repair/apply.js'
import { inspectDshHome } from '../repair/inspect.js'
import { invalidateStatus, STATUS_PATH } from './status.js'

/** Route that performs the one-click repair. */
export const REPAIR_PATH = '/plugins/dsh-plugin-health/repair'

/** Mint the per-boot control key. */
export function createRepairKey() {
  return randomBytes(24).toString('hex')
}

function sameKey(expected, presented) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(presented)
  return timingSafeEqual(left, right)
}

/** Name of the cookie that carries the per-launch control key to the browser. */
export const KEY_COOKIE = 'plugin_health_key'

/**
 * Read the control key a request presents: the HttpOnly cookie the status route set, or the header
 * the browser half may still send. Both are compared the same way, so neither path is weaker.
 * @param {object} req - incoming request.
 * @returns {string|undefined}
 */
export function presentedKey(req) {
  const header = req?.headers?.['x-plugin-health-key']
  if (typeof header === 'string' && header !== '') return header
  const cookie = req?.headers?.cookie
  if (typeof cookie !== 'string') return undefined
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === KEY_COOKIE) return part.slice(index + 1).trim()
  }
  return undefined
}

function hostnameOf(hostHeader) {
  const text = String(hostHeader ?? '').trim().toLowerCase()
  if (text === '') return ''
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'))
  return text.split(':')[0]
}

/**
 * Send a JSON response.
 * @param {object} res - response.
 * @param {number} status - HTTP status.
 * @param {any} body - JSON payload.
 * @param {Record<string, string>} [extraHeaders] - additional headers, such as the key cookie.
 */
function send(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...(extraHeaders ?? {}),
  })
  res.end(payload)
}

/**
 * Read a small JSON body without buffering unbounded input.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [limit] - max bytes.
 * @returns {Promise<any>} parsed body, or undefined.
 */
async function readBody(req, limit = 4096) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Create the repair handler. `dryRun` is a real feature, not a debug flag: the browser half first
 * asks for a plan, shows it, and only then asks for the write.
 * @param {{key: string, keyPath?: string, inspect?: Function, apply?: Function, resolveProfile?: Function}} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createRepairHandler({ key, inspect = inspectDshHome, apply = applyRepairs, resolveProfile }) {
  return async function repairHandler(req, res) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostnameOf(req?.headers?.host))) {
      send(res, 403, { error: 'loopback only' })
      return
    }
    if (req?.method !== 'GET' && req?.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' })
      return
    }
    if (!sameKey(key, presentedKey(req))) {
      send(res, 401, { error: 'missing or invalid control key' })
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const dryRun = req.method === 'GET' || body?.dryRun !== false
    try {
      const location = resolveProfile === undefined ? {} : resolveProfile()
      const result = inspect({ home: location.home, profile: location.profile })
      const plan = planRepairs(result.findings)
      const outcome = await apply(result.findings, { home: result.home, dryRun })
      if (!dryRun) invalidateStatus()
      send(res, 200, {
        dryRun,
        planned: plan.auto.map((finding) => ({ id: finding.id, description: finding.fix?.description ?? '' })),
        manual: plan.manual.length,
        actions: outcome.actions,
        skipped: outcome.skipped.map((item) => ({ id: item.id, reason: item.skipReason ?? '' })),
        quarantineDir: outcome.quarantineDir,
        summary: result.summary,
      })
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Mount both routes on the host's web server.
 * @param {object} ctx - Cordis context.
 * @param {{getStatus: () => object, resolveProfile?: () => object}} options - providers.
 * @returns {string} the control key, so sibling routes (rescue) guard with the same one
 *   instead of minting a second key that has to be kept in sync.
 */
export function registerRepairRoute(ctx, { getStatus, resolveProfile }) {
  const key = createRepairKey()
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: createStatusHandler(getStatus, key),
      })
      const disposeRepair = webCtx.webServer.register({
        kind: 'exact',
        path: REPAIR_PATH,
        handler: createRepairHandler({ key, resolveProfile }),
      })
      return () => {
        disposeStatus()
        disposeRepair()
      }
    }, 'dsh-plugin-health: status + repair routes')
  })
  return key
}

/**
 * Deliver the control key to the browser without handing it to every local process.
 *
 * The previous version put the key in the status body, which defeated its own purpose: any local
 * process could GET /status and receive the key, so the key protected nothing. A local HTTP client
 * and the browser's own page are indistinguishable by connection.
 *
 * The key is now delivered as an HttpOnly, SameSite=Strict cookie on the loopback origin. A page
 * served from that origin sends it automatically; `fetch(..., { credentials: 'same-origin' })`
 * includes it. A different local process can still *send* a forged cookie — it knows its own
 * value — but it cannot make the browser attach this one to a cross-origin request, and
 * SameSite=Strict keeps it off any third-party-initiated request. The remaining trust boundary is
 * the loopback interface itself, which is stated plainly in the comments rather than papered over.
 *
 * `HttpOnly` keeps the value out of reach of page scripts, so an XSS in any *other* plugin cannot
 * steal it. Our own client never reads the value; it only relies on the cookie being sent.
 * @param {string} key - the per-launch control key.
 * @returns {Record<string, string>} headers to add to the status response.
 */
export function keyCookieHeaders(key) {
  if (typeof key !== 'string' || key === '') return {}
  return {
    // No `Max-Age`: the cookie dies with the browser session, matching the per-launch key.
    'set-cookie': `plugin_health_key=${key}; Path=/; HttpOnly; SameSite=Strict`,
  }
}

/**
 * Serve the status snapshot.
 *
 * The snapshot no longer carries the control key. It is delivered once, as an HttpOnly cookie, so
 * page scripts cannot read it and other local processes cannot obtain it from this endpoint.
 * @param {() => object} getStatus - status provider.
 * @param {string} key - repair control key.
 * @returns {(req: object, res: object) => Promise<void>} handler.
 */
export function createStatusHandler(getStatus, key) {
  return async function statusHandler(req, res) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostnameOf(req?.headers?.host))) {
      send(res, 403, { error: 'loopback only' })
      return
    }
    if (req?.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const body = await getStatus()
      send(res, 200, body, keyCookieHeaders(key))
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
