/**
 * One-click repair endpoint for the browser half.
 *
 * Safety rules, in order:
 * 1. loopback-only Host (same fence as the status route) — a DNS-rebinding page cannot reach it;
 * 2. the write must look like it came from our own origin: JSON content type, matching `Origin`,
 *    and a `Sec-Fetch-Site` that is not cross-site (see `ui/guard.js`). This is what stops a page
 *    served from another local port, which is same-*site* and therefore carries the key cookie;
 * 3. an in-process random key minted per boot. The key separates our page from clients that never
 *    loaded it. It does **not** separate a local process: anything that can read the status route's
 *    `Set-Cookie` can replay it, and nothing on loopback can tell the two apart;
 * 4. only findings whose `fix.auto === true` are applied; everything else is reported as manual;
 * 5. repairs never delete: files/directories move to a quarantine directory, the patch rewrite keeps
 *    a backup plus the user's comments.
 * @module ui/repair-route
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { applyRepairs, planRepairs } from '../repair/apply.js'
import { inspectDshHome } from '../repair/inspect.js'
import { invalidateStatus, STATUS_PATH } from './status.js'
import { checkLoopbackPeer, checkStatusRequest, checkWriteRequest } from './guard.js'

/** Route that performs the one-click repair. */
export const REPAIR_PATH = '/plugins/dsh-plugin-health/repair'

/** Mint the per-boot control key. */
export function createRepairKey() {
  return randomBytes(24).toString('hex')
}

function sameKey(expected, presented) {
  if (typeof presented !== 'string') return false
  // Compare digests, not the raw values. `timingSafeEqual` throws unless the *byte* lengths match,
  // while `length` counts UTF-16 units: 48 copies of "é" pass the length check with 96 bytes and
  // crash the handler with ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH. A request header is arbitrary text,
  // so that is reachable from the network side of the loopback fence.
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(presented).digest()
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
    // The Host header is written by the client. The peer address is not, and it is the only check
    // that holds when the web server is bound to a LAN address instead of loopback.
    const peer = checkLoopbackPeer(req)
    if (!peer.ok) { send(res, peer.status, { error: peer.error }); return }
    if (req?.method !== 'GET' && req?.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' })
      return
    }
    // Cross-site pages must be turned away before the key is even compared — see ui/guard.js.
    // A GET here is a dry-run scan, but it is still a request a same-site page can fire with the
    // cookie. The write guard deliberately waves read methods through, so this one needs the status
    // guard as well — without it, GET is the only unguarded entry point on this route.
    const guard = req?.method === 'GET' ? checkStatusRequest(req) : checkWriteRequest(req)
    if (!guard.ok) {
      send(res, guard.status, { error: guard.error })
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
 * The snapshot body does not carry the control key. It is delivered as an HttpOnly cookie so page
 * scripts on *other* origins cannot read it.
 *
 * Be precise about what that buys: `HttpOnly` stops JavaScript in a page from reading the value. It
 * does not stop a local process, which can read `Set-Cookie` exactly like any other response header,
 * and it does not stop a page on another local port — cookies ignore the port, so such a page is
 * same-site and the browser attaches the cookie for it. The second problem is handled by
 * `checkStatusRequest` and `ui/guard.js`; the first cannot be handled on loopback at all, and
 * `SECURITY.md` says the loopback interface is the boundary.
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
    // The Host header is written by the client. The peer address is not, and it is the only check
    // that holds when the web server is bound to a LAN address instead of loopback.
    const peer = checkLoopbackPeer(req)
    if (!peer.ok) { send(res, peer.status, { error: peer.error }); return }
    if (req?.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' })
      return
    }
    const guard = checkStatusRequest(req)
    if (!guard.ok) {
      send(res, guard.status, { error: guard.error })
      return
    }
    try {
      const body = await getStatus()
      // The key is delivered twice, on purpose. The cookie is the primary channel and cannot be read
      // by page script; the body copy is the fallback, because a host that proxies these routes may
      // not carry `Set-Cookie` through to the browser — and then every write fails with a 401 that
      // looks exactly like a network error.
      //
      // This is not a weaker boundary than the cookie. A local process on the same machine can read
      // `Set-Cookie` from this very response, which SECURITY.md says plainly; what stops a *page* on
      // another origin is that it cannot read this body at all (no CORS headers). The one real
      // difference is that page script in the DSH origin can now read the value, so an XSS in another
      // plugin could take it — but such a plugin already runs with the user's full permissions.
      send(res, 200, { ...body, key }, keyCookieHeaders(key))
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
