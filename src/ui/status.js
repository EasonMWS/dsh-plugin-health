/**
 * Host half of the DSH plugin-health UI: a read-only JSON snapshot of the local profile, consumed
 * by the browser half (`./client.js`) through a loopback-only route.
 * @module ui/status
 */
import { inspectDshHome } from '../repair/inspect.js'
/** Route the browser half reads; absolute so it works from the DSH web origin. */
export const STATUS_PATH = '/plugins/dsh-plugin-health/status'

/**
 * Turn an inspection result into the small document the UI consumes.
 * @param {{home?: string, profile?: string, runtimeVersion?: string, now?: number}} [options]
 * @returns {{schemaVersion: number, generatedAt: string, runtimeVersion: string|null, profile: string|null, profileDir: string|null, home: string, summary: object, incompatible: number, issues: object[]}}
 */
export function buildStatus({ home, profile, runtimeVersion, now = Date.now() } = {}) {
  const result = inspectDshHome({ home, profile, runtimeVersion })
  const issues = result.findings.map((item) => ({
    id: item.id,
    severity: item.severity,
    title: item.title,
    detail: item.detail ?? '',
    fix: item.fix?.description ?? '',
    autoFixable: item.fix?.auto === true,
  }))
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    runtimeVersion: typeof runtimeVersion === 'string' && runtimeVersion !== '' ? runtimeVersion : null,
    profile: result.profile ?? null,
    profileDir: result.profileDir ?? null,
    home: result.home,
    summary: result.summary,
    incompatible: issues.filter((issue) => issue.id === 'plugin-incompatible').length,
    issues,
  }
}

/**
 * Throttled snapshot, so a UI poll never re-walks node_modules on every render.
 * @param {{home?: string, profile?: string, runtimeVersion?: string}} options
 * @param {number} [ttlMs] - cache lifetime.
 * @returns {object} status document.
 */
export function cachedStatus(options, ttlMs = 5_000) {
  const now = Date.now()
  const key = JSON.stringify([options?.home ?? '', options?.profile ?? '', options?.runtimeVersion ?? ''])
  if (cache !== undefined && cache.key === key && now - cache.at < ttlMs) return cache.value
  const value = buildStatus({ ...options, now })
  cache = { key, at: now, value }
  return value
}

let cache

/**
 * Drop the cached snapshot so the next read sees a repair that just happened.
 * @returns {void}
 */
export function invalidateStatus() {
  cache = undefined
}

/**
 * Snapshot of the *running* profile, read from the host's `profileContext` service.
 * @param {object} ctx - Cordis host context.
 * @returns {{home?: string, profile?: string}}
 */
export function runningProfile(ctx) {
  try {
    const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    const directory = typeof profileContext?.dir === 'string' ? profileContext.dir : undefined
    const name = typeof profileContext?.name === 'string' ? profileContext.name : undefined
    // profileContext.dir is <home>/profiles/<name>; prefer the explicit home when derivable.
    const home = directory === undefined ? undefined : directory.replace(/[\\/]profiles[\\/][^\\/]+$/u, '')
    return { home, profile: name }
  } catch {
    return {}
  }
}

/**
 * Mount the read-only status route on a DSH web host context.
 * @param {object} ctx - Cordis context with `inject` and `effect`.
 * @param {{getStatus: () => object}} options - status provider.
 * @returns {void}
 */
export function registerStatusRoute(ctx, { getStatus }) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: createStatusHandler(getStatus),
      })
      return () => dispose()
    }, 'dsh-plugin-health: status route')
  })
}

function hostnameOf(hostHeader) {  const text = String(hostHeader ?? '').trim().toLowerCase()
  if (text === '') return ''
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'))
  return text.split(':')[0]
}

/**
 * Create the loopback-only HTTP handler.
 * @param {() => object} getStatus - status provider.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createStatusHandler(getStatus) {
  return async function statusHandler(req, res) {
    const hostname = hostnameOf(req?.headers?.host)
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
      send(res, 403, { error: 'loopback only' })
      return
    }
    if (req?.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      send(res, 200, await getStatus())
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
