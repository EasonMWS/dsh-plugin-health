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
 * 2. The request's own origin has to match. `Origin`, when present, must equal the request's `Host`;
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
  // has to declare itself JSON.
  const declared = req?.headers?.['content-length']
  const mayBeEmpty = mediaType === '' && (declared === undefined || declared === '0')
  if (!mayBeEmpty && mediaType !== 'application/json') {
    return { ok: false, status: 415, error: 'write requests must be application/json' }
  }

  const host = String(req?.headers?.host ?? '').trim().toLowerCase()
  const origin = req?.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    // Same-origin means the Origin's authority is exactly the Host we were reached on.
    let authority
    try {
      authority = new URL(origin).host.toLowerCase()
    } catch {
      return { ok: false, status: 403, error: 'cross-origin request refused' }
    }
    if (host === '' || authority !== host) return { ok: false, status: 403, error: 'cross-origin request refused' }
  }

  const site = req?.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: 'cross-site request refused' }
  }

  return { ok: true }
}

/**
 * Guard for the status route, which is a GET but still hands out the control cookie. A page on
 * another local port could otherwise seed the cookie with a background fetch and then drive the
 * write routes without ever reading the value.
 * @param {object} req
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkStatusRequest(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: 'cross-site request refused' }
  }
  return { ok: true }
}