/**
 * Host half of the rescue UI: the routes behind the "fix it" button.
 *
 * Three routes, all loopback-only and all behind the same per-launch control key the
 * existing repair route uses, because they change profile state:
 *
 *   POST .../rescue/rehearse   rehearse in a throwaway home — writes nothing
 *   POST .../rescue/apply      rehearse, then grant the exemption if it booted
 *   POST .../rescue/undo       revoke exemptions this tool granted
 *
 * The rehearsal is deliberately a separate step from the apply. The UI shows the
 * verdict between the two, so a user sees "this will work" before anything in their
 * profile changes.
 * @module ui/rescue-route
 */
import { randomBytes } from 'node:crypto'

import { rehearse, rescuePlugin, undoRescue, auditRescues } from '../rescue/rescue.js'
import { checkUpstream } from '../rescue/upstream.js'
import { discoverDshDirectory } from '../rescue/environment.js'

/** Route namespace, absolute so the browser half can call it from the DSH origin. */
export const RESCUE_PATH = '/plugins/dsh-plugin-health/rescue'

/** Per-launch control key; the browser half receives it with the status snapshot. */
export const RESCUE_KEY = randomBytes(24).toString('hex')

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function hostnameOf(header) {
  const text = String(header ?? '').trim().toLowerCase()
  if (text === '') return ''
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'))
  return text.split(':')[0]
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

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Turn a rescue verdict into the level the UI colours by, plus a locale key it translates.
 * The sentence itself lives in the browser half's dictionaries: the host must not decide
 * which language the user reads.
 * @param {string} verdict
 * @returns {{level: 'ok'|'warn'|'error', messageKey: string}}
 */
export function verdictMessage(verdict) {
  if (verdict === 'runs') return { level: 'ok', messageKey: 'rescueVerdictRuns' }
  if (verdict === 'broken') return { level: 'error', messageKey: 'rescueVerdictBrokenWhy' }
  return { level: 'warn', messageKey: 'rescueVerdictInconclusive' }
}

/**
 * Build the handler set. Exported for tests to drive without a real web server.
 * @param {object} options
 * @param {() => {home?: string, profile?: string, runtimeVersion?: string}} options.currentProfile
 * @returns {object} route handlers keyed by action.
 */
export function createRescueHandlers({ currentProfile, dshDirectoryOf = discoverDshDirectory, rehearseImpl = rehearse, rescueImpl = rescuePlugin, undoImpl = undoRescue, auditImpl = auditRescues, upstreamImpl = checkUpstream }) {
  /** Resolve the profile context or fail with a readable reason. */
  const context = () => {
    const { home, profile, runtimeVersion } = currentProfile() ?? {}
    if (home === undefined || profile === undefined) throw new Error('the running profile is unknown')
    return { home, profile, profileDir: `${home}/profiles/${profile}`, runtimeVersion }
  }
  return {
    async rehearse(body) {
      const { home, profile, profileDir, runtimeVersion } = context()
      if (typeof body.plugin !== 'string' || typeof body.version !== 'string') {
        throw new Error('rescue needs plugin and version')
      }
      const dshDirectory = body.dshDirectory ?? dshDirectoryOf(home, profileDir)
      if (dshDirectory === undefined) throw new Error('no installed @deepseek-ai/dsh found to rehearse against')
      const result = await rehearseImpl({
        dshDirectory,
        plugin: `${body.plugin}@${body.version}`,
        runtimeVersion: runtimeVersion ?? body.runtimeVersion,
        timeoutMs: body.timeoutMs, installTimeoutMs: body.installTimeoutMs,
      })
      return {
        verdict: result.verdict,
        ...verdictMessage(result.verdict),
        evidence: result.report?.directory ?? null,
        hostVersion: result.report?.hostVersion ?? null,
        canApply: result.verdict === 'runs',
      }
    },
    async apply(body) {
      const { home, profileDir, profile, runtimeVersion } = context()
      if (typeof body.plugin !== 'string' || typeof body.version !== 'string') {
        throw new Error('rescue needs plugin and version')
      }
      // discoverDshDirectory takes (home, profileDir); passing only one argument would
      // silently search the wrong directories.
      const dshDirectory = body.dshDirectory ?? dshDirectoryOf(home, profileDir)
      if (dshDirectory === undefined) throw new Error('no installed @deepseek-ai/dsh found to rehearse against')
      const result = await rescueImpl({
        profileDir, profile, dshDirectory,
        plugin: `${body.plugin}@${body.version}`,
        runtimeVersion: runtimeVersion ?? body.runtimeVersion,
        dryRun: false,
        timeoutMs: body.timeoutMs, installTimeoutMs: body.installTimeoutMs,
      })
      return {
        applied: result.applied === true,
        verdict: result.verdict,
        ...verdictMessage(result.verdict),
        entry: result.entry ?? null,
      }
    },
    async undo(body) {
      const { profileDir } = context()
      const { undone, remaining } = undoImpl(profileDir, typeof body.key === 'string' ? { key: body.key } : {})
      return { undone, remaining: remaining.length }
    },
    async status() {
      const { profileDir, runtimeVersion } = context()
      const audits = auditImpl(profileDir, {
        readManifest: () => undefined,
        runtimeVersion,
      })
      const active = audits.filter(entry => entry.active)
      const upstream = active.length === 0 ? [] : await upstreamImpl({
        entries: active, profileDir, runtimeVersion,
      })
      return {
        entries: audits.map((entry) => {
          const found = upstream.find(item => item.key === entry.key)
          return { ...entry, upstream: found?.status ?? null, target: found?.target ?? null }
        }),
      }
    },
  }
}

/**
 * Mount the rescue routes.
 *
 * Reuses the control key minted by the repair route rather than minting a second one:
 * both guard the same trust boundary (the page that received this boot's status
 * document), and two keys would mean two things to keep in sync.
 * @param {object} ctx - Cordis context.
 * @param {{currentProfile: () => {home?: string, profile?: string, runtimeVersion?: string}, key: string}} options
 */
export function registerRescueRoute(ctx, { currentProfile, key }) {
  if (typeof key !== 'string' || key === '') throw new Error('rescue route needs the control key from the repair route')
  const handlers = createRescueHandlers({ currentProfile })
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: RESCUE_PATH,
        handler: async (req, res) => {
          if (!LOOPBACK.has(hostnameOf(req?.headers?.host))) { send(res, 403, { error: 'loopback only' }); return }
          if (req?.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return }
          const action = String(req.url ?? '').split('?')[0].replace(RESCUE_PATH, '').replace(/^\//u, '')
          const handler = handlers[action]
          if (handler === undefined) { send(res, 404, { error: `unknown rescue action: ${action}` }); return }
          try {
            // The control key is required for every action: a page on another origin can
            // reach loopback, so the host check alone is not an authorisation boundary.
            if (req.headers['x-plugin-health-key'] !== key) { send(res, 401, { error: 'missing or invalid control key' }); return }
            const body = await readBody(req)
            send(res, 200, await handler(body))
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      return () => dispose()
    }, 'dsh-plugin-health: rescue route')
  })
}
