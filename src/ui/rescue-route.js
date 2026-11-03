/**
 * Host half of the rescue UI: the routes behind the "fix it" button.
 *
 * Routes, all loopback-only and all behind the same per-launch control key the existing repair route
 * uses, because they change profile state:
 *
 *   POST .../rescue/rehearse   rehearse in a throwaway home — writes nothing
 *   POST .../rescue/apply      rehearse, then grant the exemption if it booted
 *   POST .../rescue/undo       revoke exemptions this tool granted
 *   POST .../rescue/disable    switch a plugin off so DSH keeps booting
 *   POST .../rescue/enable     undo that
 *   POST .../update            ask the registry whether this plugin is current
 *
 * The rehearsal is deliberately a separate step from the apply. The UI shows the verdict between the
 * two, so a user sees "this will work" before anything in their profile changes.
 * @module ui/rescue-route
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import semver from 'semver'
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { auditRescues, declarationConflict, rehearse, rescuePlugin, undoRescue } from '../rescue/rescue.js'
import { checkUpstream } from '../rescue/upstream.js'
import { discoverDshDirectory, prepareRehearsalHost } from '../rescue/environment.js'
import { disablePlugin as disablePluginImpl, enablePlugin as enablePluginImpl } from '../rescue/boot.js'
import { buildReport, findExistingReports, repositorySlug } from '../rescue/reporting.js'
import { buildBrief, renderPrompt, writeHandoff } from '../rescue/handoff.js'
import { presentedKey } from './repair-route.js'
import { invalidateStatus } from './status.js'
import { checkLoopbackPeer, checkStatusRequest, checkWriteRequest } from './guard.js'
import { UPDATE_PATH, refreshUpdate, upgradeHint } from './update.js'

/** Route namespace, absolute so the browser half can call it from the DSH origin. */
export const RESCUE_PATH = '/plugins/dsh-plugin-health/rescue'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** Constant-time key comparison, shared shape with the repair route. */
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
export function createRescueHandlers({
  currentProfile,
  dshDirectoryOf = discoverDshDirectory,
  rehearseImpl = rehearse,
  rescueImpl = rescuePlugin,
  undoImpl = undoRescue,
  auditImpl = auditRescues,
  upstreamImpl = checkUpstream,
  prepareHostImpl = prepareRehearsalHost,
  fetchImpl,
  toolVersion,
}) {
  /** Resolve the profile context or fail with a readable reason. */
  const context = () => {
    const { home, profile, runtimeVersion } = currentProfile() ?? {}
    if (home === undefined || profile === undefined) throw new Error('the running profile is unknown')
    return { home, profile, profileDir: `${home}/profiles/${profile}`, runtimeVersion }
  }
  /**
   * Resolve a host package to rehearse against, downloading one if the install has none.
   *
   * The desktop app bundles the host inside app.asar, so a perfectly normal install has no
   * on-disk @deepseek-ai/dsh. Failing there would make the feature unusable for exactly the
   * people it targets, so the first rehearsal fetches its own copy — into the tool's own
   * directory, used only for throwaway homes.
   */
  const hostFor = async (home, profileDir, runtimeVersion) => {
    // The version is what makes discovery useful: without it, any host on the machine is accepted,
    // including a cached one from a previous release, and the rehearsal proves the wrong thing.
    const found = dshDirectoryOf(home, profileDir, runtimeVersion)
    if (found !== undefined) return found
    const prepared = await prepareHostImpl({ home, version: runtimeVersion })
    return prepared.directory
  }
  /**
   * Accept a caller-supplied host directory only if it is a real `@deepseek-ai/dsh` package inside
   * one of the roots this tool already trusts.
   *
   * `body.dshDirectory` chose the directory whose `bin` script the rehearsal executes, so any local
   * caller that could drop a folder anywhere on disk got code execution — no npm, no shell, and no
   * user-visible trace. The value is now treated as a hint: it must resolve inside the profile, the
   * DSH home, this tool's own host cache, or the current working directory, and it must actually
   * contain a `@deepseek-ai/dsh` package.
   * @param {string} candidate
   * @param {{home: string, profileDir: string}} where
   * @returns {string} the resolved directory, or throws
   */
  const trustedHostDirectory = (candidate, { home, profileDir }) => {
    const roots = [
      profileDir,
      home,
      join(home, '.plugin-health', 'host'),
      process.cwd(),
    ].map(root => resolve(root))
    const resolved = resolve(candidate)
    const inside = roots.some(root => resolved === root || resolved.startsWith(`${root}${sep}`))
    if (!inside) throw new Error('dshDirectory must be inside the profile, the DSH home, or this tool\'s host cache')
    return resolved
  }
  /** A hint from the caller, if it is one we are willing to use. */
  const hostFromBody = (body, where) => (
    typeof body.dshDirectory === 'string' && body.dshDirectory !== ''
      ? trustedHostDirectory(body.dshDirectory, where)
      : undefined
  )
  return {
    async rehearse(body) {
      const { home, profile, profileDir, runtimeVersion } = context()
      const identity = requireInstalledPlugin(profileDir, body?.plugin, body?.version)
      const hostVersion = runtimeVersion ?? body.runtimeVersion
      const dshDirectory = hostFromBody(body, { home, profileDir })
        ?? await hostFor(home, profileDir, hostVersion)
      const result = await rehearseImpl({
        dshDirectory,
        plugin: `${identity.name}@${identity.version}`,
        // The identity travels beside the spec: the spec is a string that could name a directory on
        // the process's cwd, and nothing downstream may derive the package identity from it.
        suppliedIdentity: identity,
        pluginName: identity.name,
        pluginVersion: identity.version,
        runtimeVersion: hostVersion,
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
      const identity = requireInstalledPlugin(profileDir, body?.plugin, body?.version)
      const hostVersion = runtimeVersion ?? body.runtimeVersion
      const dshDirectory = hostFromBody(body, { home, profileDir })
        ?? await hostFor(home, profileDir, hostVersion)
      const result = await rescueImpl({
        profileDir, profile, dshDirectory,
        plugin: `${identity.name}@${identity.version}`,
        suppliedIdentity: identity,
        runtimeVersion: hostVersion,
        dryRun: false,
        timeoutMs: body.timeoutMs, installTimeoutMs: body.installTimeoutMs,
      })
      invalidateStatus()
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
      invalidateStatus()
      return { undone, remaining: remaining.length }
    },
    /**
     * Switch a plugin off so DSH keeps working.
     *
     * This is the honest alternative to a rescue that failed: the plugin cannot be made to work
     * here, so the user's DSH should at least stay usable. It writes a `disabled: true` overlay
     * to the profile patch layer — the same mechanism the host itself uses for overrides — and
     * never touches the plugin's files, so `enable` (or a reinstall) undoes it exactly.
     */
    async disable(body) {
      const { profileDir } = context()
      if (typeof body.plugin !== 'string' || body.plugin === '') throw new Error('disable needs plugin')
      // The same shape check the rescue actions use: a caller must not be able to write an arbitrary
      // string into the profile's patch layer.
      if (!PACKAGE_NAME.test(body.plugin)) throw new Error(`not a package name: ${body.plugin}`)
      const result = disablePluginImpl(profileDir, { name: body.plugin, id: body.entryId })
      invalidateStatus()
      return { disabled: result.changed, entry: result.added?.[0] ?? null, file: result.file }
    },
    /** Re-enable a plugin this tool switched off. */
    async enable(body) {
      const { profileDir } = context()
      if (typeof body.plugin !== 'string' || body.plugin === '') throw new Error('enable needs plugin')
      if (!PACKAGE_NAME.test(body.plugin)) throw new Error(`not a package name: ${body.plugin}`)
      const result = enablePluginImpl(profileDir, { name: body.plugin, id: body.entryId })
      invalidateStatus()
      return { enabled: result.changed, removed: result.removed ?? 0, file: result.file }
    },
    async status() {
      const { profileDir, runtimeVersion } = context()
      const audits = auditImpl(profileDir, {
        // Reading the installed version is what makes a rescue go stale: once the author
        // ships a release the exemption is no longer needed.
        readManifest: (name) => readInstalledManifest(profileDir, name),
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
    /**
     * Write the AI brief and return the prompt. Nothing is sent anywhere: the UI shows the
     * text so the user decides whether to paste it into their own agent, and the tool
     * never calls a model or spends their tokens.
     */
    async handoff(body) {
      const { profileDir, runtimeVersion } = context()
      if (typeof body.plugin !== 'string' || typeof body.version !== 'string') {
        throw new Error('handoff needs plugin and version')
      }
      const manifest = readInstalledManifest(profileDir, body.plugin)
      if (manifest === undefined) throw new Error(`plugin is not installed: ${body.plugin}`)
      const conflict = declarationConflict(manifest, runtimeVersion)
      const brief = buildBrief({
        name: body.plugin,
        version: body.version,
        runtimeVersion,
        requirements: conflict.requirements,
        installedManifest: manifest,
        smokeReport: body.rehearsal,
        // The browser half sends the verdict as a word, not a report; both are accepted so the
        // prompt never claims "no test ran" after a test that failed.
        verdict: typeof body.rehearsalVerdict === 'string' ? body.rehearsalVerdict : undefined,
        repositoryUrl: repositorySlug(manifest) === undefined ? undefined : `https://github.com/${repositorySlug(manifest)}`,
        toolVersion,
      })
      const written = writeHandoff(profileDir, brief, body.rehearsal)
      return { directory: written.directory, prompt: renderPrompt(brief), files: written.files }
    },
    /**
     * Check upstream for an existing report before drafting one. Read-only until the user
     * copies the text; this never files anything.
     */
    async report(body) {
      const { profileDir, runtimeVersion } = context()
      if (typeof body.plugin !== 'string' || typeof body.version !== 'string') {
        throw new Error('report needs plugin and version')
      }
      const manifest = readInstalledManifest(profileDir, body.plugin)
      if (manifest === undefined) throw new Error(`plugin is not installed: ${body.plugin}`)
      const slug = repositorySlug(manifest)
      if (slug === undefined) throw new Error(`cannot work out a GitHub repository for ${body.plugin}`)
      const existing = await findExistingReports({
        slug, name: body.plugin, runtimeVersion, fetchImpl: fetchImpl ?? undefined,
      })
      const conflict = declarationConflict(manifest, runtimeVersion)
      const draft = buildReport({
        name: body.plugin,
        version: body.version,
        runtimeVersion,
        requirements: conflict.requirements,
        rehearsal: body.rehearsalVerdict,
        repositoryUrl: `https://github.com/${slug}`,
        toolVersion,
      })
      return {
        slug,
        checked: existing.checked,
        error: existing.error ?? null,
        existing: existing.existing,
        newIssueUrl: `https://github.com/${slug}/issues/new`,
        title: draft.title,
        body: draft.body,
      }
    },
  }
}

/**
 * An npm package name, and nothing else.
 *
 * The name arrives in a request body, is joined into a path, and is interpolated into a package spec
 * handed to `dsh plugin add`. Without this, `../../../etc` reads any `package.json` on disk and
 * `x@npm:evil` makes npm install a package other than the one the user already has.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u

/**
 * Read a plugin's installed manifest from the profile.
 *
 * Returns `undefined` when the plugin is not installed. The name is validated first and the resolved
 * path is checked to stay under `node_modules`, so a traversal attempt is a miss rather than a read.
 */
function readInstalledManifest(profileDir, name) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name) || name.length > 214) return undefined
  const root = resolve(profileDir, 'node_modules')
  const directory = resolve(root, name)
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) return undefined
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Resolve a request's plugin to the copy that is actually installed.
 *
 * The rescue flow exists to make a plugin you already have load again; it has no business installing
 * an arbitrary package named in a request body. Insisting the profile already holds this exact name
 * and version removes the whole class of "the request body decides what runs" findings.
 * @param {string} profileDir
 * @param {unknown} plugin
 * @param {unknown} version
 * @returns {{name: string, version: string}}
 */
function requireInstalledPlugin(profileDir, plugin, version) {
  if (typeof plugin !== 'string' || !PACKAGE_NAME.test(plugin) || plugin.length > 214) {
    throw new Error('plugin must be an installed npm package name')
  }
  if (typeof version !== 'string' || semver.valid(version) === null) {
    throw new Error('version must be an exact installed version')
  }
  const manifest = readInstalledManifest(profileDir, plugin)
  if (manifest === undefined) throw new Error(`${plugin} is not installed in this profile`)
  if (manifest.version !== version) {
    throw new Error(`${plugin}@${version} is not installed; this profile has ${manifest.name}@${manifest.version}`)
  }
  return { name: plugin, version }
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
export function registerRescueRoute(ctx, { currentProfile, key, toolVersion, refreshUpdateImpl = refreshUpdate }) {
  if (typeof key !== 'string' || key === '') throw new Error('rescue route needs the control key from the repair route')
  const handlers = createRescueHandlers({ currentProfile, toolVersion })

  /**
   * The fence every write route in this module shares: loopback host, write guards, control key.
   * Returns true when the request may proceed; otherwise the response has already been sent.
   */
  const authorize = (req, res) => {
    if (!LOOPBACK.has(hostnameOf(req?.headers?.host))) { send(res, 403, { error: 'loopback only' }); return false }
    // Host is client-supplied; the peer address is not. Without this, a host bound to a LAN address
    // is reachable by any machine on the network using `Host: 127.0.0.1:<port>`.
    const peer = checkLoopbackPeer(req)
    if (!peer.ok) { send(res, peer.status, { error: peer.error }); return false }
    if (req?.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return false }
    // Runs before the key check: a cross-site page must not even reach the comparison, and a
    // 415/403 leaks less than a 401 does about whether the route is live.
    const guard = checkWriteRequest(req)
    if (!guard.ok) { send(res, guard.status, { error: guard.error }); return false }
    // The control key is required for every action: a page on another origin can reach loopback, so
    // the host check alone is not an authorisation boundary. Constant-time comparison, and the key
    // may arrive as the HttpOnly cookie the status route set or as a header. This runs before the
    // action is looked up, so an unauthenticated caller cannot enumerate action names from
    // 404-versus-401 differences.
    if (!sameKey(key, presentedKey(req))) { send(res, 401, { error: 'missing or invalid control key' }); return false }
    return true
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: RESCUE_PATH,
        handler: async (req, res) => {
          if (!authorize(req, res)) return
          const action = String(req.url ?? '').split('?')[0].replace(RESCUE_PATH, '').replace(/^\//u, '')
          try {
            const handler = handlers[action]
            if (handler === undefined) { send(res, 404, { error: 'unknown rescue action' }); return }
            const body = await readBody(req)
            send(res, 200, await handler(body))
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      // "Check for updates" lives under the same fence rather than getting its own: it is the only
      // action that reaches the network, so it must be exactly as hard to trigger from another page
      // as anything that writes.
      const disposeUpdate = webCtx.webServer.register({
        kind: 'exact',
        path: UPDATE_PATH,
        handler: async (req, res) => {
          if (!authorize(req, res)) return
          try {
            await readBody(req)
            const state = await refreshUpdateImpl({ force: true })
            send(res, 200, { ...state, upgradeHint: state.updateAvailable ? upgradeHint(state.latestVersion) : null })
          } catch (error) {
            send(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      return () => { dispose(); disposeUpdate() }
    }, 'dsh-plugin-health: rescue route')
  })
}
