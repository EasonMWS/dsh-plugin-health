/**
 * Request guards shared by the write routes.
 *
 * The control key alone is not an authorisation boundary between pages, only between the tool and
 * clients that do not run our page. Cookies are scoped by host and ignore the port, so a page served
 * from any other `127.0.0.1:<port>` — a dev server, a notebook, a preview — is *same-site* with the
 * DSH origin: `SameSite=Strict` does not stop it, and it can attach the key without ever reading it.
 *
 * Two independent checks close that:
 *
 * 1. `Content-Type: application/json` is required for writes. A `text/plain` POST is a CORS simple
 *    request and needs no preflight; requiring a non-simple type forces one, and the preflight fails
 *    because the routes answer OPTIONS with 405 and no CORS headers.
 * 2. The request's own origin has to match the transport scheme, host and port;
 *    `Sec-Fetch-Site`, when present, must be `same-origin` or `none`. Both are set by the browser and
 *    cannot be forged by page script.
 *
 * Neither check defends against a local process that speaks HTTP directly — nothing on loopback
 * can, and `SECURITY.md` says so.
 */

/** Methods that never need the write guards. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * @param {object} req - incoming request.
 * @returns {string} lowercased media type, without parameters.
 */
function mediaTypeOf(req) {
  const raw = req?.headers?.['content-type']
  if (typeof raw !== 'string') return ''
  return raw.split(';')[0].trim().toLowerCase()
}

/**
 * @param {object} req
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkWriteRequest(req) {
  if (READ_METHODS.has(String(req?.method ?? '').toUpperCase())) return { ok: true }

  const mediaType = mediaTypeOf(req)
  // An empty body is legitimate for actions that take no arguments, but when a body is present it
  // has to declare itself JSON. "No content-length" is not the same as "no body": a chunked request
  // has no length and can carry anything, so only an explicit zero counts as empty.
  const declared = req?.headers?.['content-length']
  const chunked = req?.headers?.['transfer-encoding'] !== undefined
  const mayBeEmpty = mediaType === '' && !chunked && (declared === undefined || declared === '0' || declared === 0)
  if (!mayBeEmpty && mediaType !== 'application/json') {
    return { ok: false, status: 415, error: 'write requests must be application/json' }
  }

  return checkStatusRequest(req)
}

/** Origin is scheme + host + port. Forwarded headers are not a trusted TLS signal. */
function checkOrigin(req) {
  const origin = req?.headers?.origin
  if (origin === undefined) return { ok: true }
  try {
    if (typeof origin !== 'string') throw new Error('invalid origin')
    const parsed = new URL(origin)
    const expected = new URL(`${req?.socket?.encrypted ? 'https' : 'http'}://${req?.headers?.host}`)
    if (parsed.origin !== origin || parsed.origin !== expected.origin) throw new Error('different origin')
  } catch {
    return { ok: false, status: 403, error: 'cross-origin request refused' }
  }
  return { ok: true }
}

function checkFetchSite(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: 'cross-site request refused' }
  }

  return { ok: true }
}

/**
 * Is the connection actually coming from this machine?
 *
 * Every route so far checked only the `Host` header, which the client writes — so with the web server
 * bound to a LAN address, another machine on the network could send `Host: 127.0.0.1:<port>` and pass.
 * The peer address is the one part of the connection a client cannot choose.
 * @param {object} req
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkLoopbackPeer(req) {
  const address = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress
  // No socket means a hand-built request (tests, internal calls). There is nothing to verify, and
  // every real request has one.
  if (typeof address !== 'string' || address === '') return { ok: true }
  if (LOOPBACK_ADDRESSES.some(pattern => pattern.test(address))) return { ok: true }
  return { ok: false, status: 403, error: 'loopback only' }
}

/**
 * Peer addresses that mean "this machine".
 *
 * IPv4 loopback is all of 127.0.0.0/8, not just 127.0.0.1 — some systems resolve `localhost` to
 * 127.0.0.53 or similar. An IPv4 connection over a dual-stack socket arrives as `::ffff:127.0.0.1`.
 */
const LOOPBACK_ADDRESSES = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u,
  /^::1$/u,
  /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u,
  /^0:0:0:0:0:0:0:1$/u,
]

/**
 * Guard for the status route, which is a GET but still hands out the control cookie. A page on
 * another local port could otherwise seed the cookie with a background fetch and then drive the
 * write routes without ever reading the value.
 * @param {object} req
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkStatusRequest(req) {
  const origin = checkOrigin(req)
  return origin.ok ? checkFetchSite(req) : origin
}
