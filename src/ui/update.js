/**
 * "Is a newer version of this plugin out?"
 *
 * DSH ships a prerelease every week or two, and this tool is the thing that tells the user their
 * plugins need attention — so being visibly out of date itself is a bad look, and a security fix only
 * helps people who actually receive it.
 *
 * Two rules shape the implementation:
 *
 * 1. **Never block startup.** The check is fired and forgotten. A registry that is slow, blocked or
 *    unreachable must not add a millisecond to booting DSH.
 * 2. **Never nag.** One request per boot, then at most once every {@link AUTO_INTERVAL_MS}. Failures
 *    are recorded but stay quiet unless the user explicitly asks for a check.
 *
 * The only thing sent is a GET for this package's own metadata — the same request an `npm install`
 * makes. There is nothing to opt out of beyond that, but `DSH_PLUGIN_HEALTH_NO_UPDATE=1` disables it
 * for anyone who wants no outbound traffic from a health tool.
 * @module ui/update
 */
import { readFileSync } from 'node:fs'

/** This package's own version, read once. */
export const CURRENT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  } catch {
    return undefined
  }
})()

/** Where the browser half asks for a fresh check. */
export const UPDATE_PATH = '/plugins/dsh-plugin-health/update'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** How long an automatic result is trusted before the next boot-time check replaces it. */
export const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How the user is told to upgrade, kept here so the UI and the CLI cannot drift. */
export function upgradeHint(version) {
  const target = typeof version === 'string' && version !== '' ? `@${version}` : ''
  return `dsh plugin --profile <profile> add dsh-plugin-health${target}`
}

/**
 * @typedef {object} UpdateState
 * @property {string|null} currentVersion
 * @property {string|null} latestVersion
 * @property {boolean} updateAvailable
 * @property {'ok'|'error'|'pending'|'never'} status
 * @property {string|null} checkedAt ISO timestamp of the last attempt that finished.
 * @property {string|null} error message when the last attempt failed.
 */

/** @type {UpdateState} */
let state = {
  currentVersion: CURRENT_VERSION ?? null,
  latestVersion: null,
  updateAvailable: false,
  status: 'never',
  checkedAt: null,
  error: null,
}

/** @type {Promise<UpdateState>|undefined} */
let inFlight

/** Timestamp of the last completed attempt, for the auto-check interval. */
let lastAttemptAt = 0

/**
 * Read the version the registry currently points `latest` at.
 * @param {{registry?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<string>} the version string.
 */
export async function fetchLatestVersion({ registry = DEFAULT_REGISTRY, timeoutMs = 8_000, fetchImpl = fetch } = {}) {
  const base = registry.replace(/\/$/u, '')
  const response = await fetchImpl(`${base}/dsh-plugin-health/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`registry answered ${response.status}`)
  const document = await response.json()
  if (typeof document?.version !== 'string' || document.version === '') {
    throw new Error('registry returned no version')
  }
  return document.version
}

/**
 * Compare two versions without a dependency: the tool's own version is semver, and a prerelease
 * must not read as newer than the release it leads to.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b.
 */
function compareVersions(a, b) {
  const parse = (text) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(String(text ?? ''))
    if (match === null) return null
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] === undefined ? [] : match[4].split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i]
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  // A release outranks any prerelease of the same numbers.
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = Number(l)
    const rn = Number(r)
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln - rn
    return l < r ? -1 : 1
  }
  return 0
}

/**
 * Whether a dev/opt-out environment should skip the check entirely.
 * @returns {boolean}
 */
function disabled() {
  const value = process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
  return value === '1' || value === 'true'
}

/**
 * Run one check. Never throws: a failure is part of the result, because "could not check" is a
 * different statement from "up to date", and the UI is allowed to say so.
 * @param {{registry?: string, timeoutMs?: number, fetchImpl?: typeof fetch, force?: boolean}} [options]
 * @returns {Promise<UpdateState>}
 */
export async function refreshUpdate({ force = false, ...options } = {}) {
  if (!force && (disabled() || Date.now() - lastAttemptAt < AUTO_INTERVAL_MS)) return snapshot()
  if (inFlight !== undefined) return inFlight
  state = { ...state, status: 'pending' }
  inFlight = (async () => {
    try {
      const latestVersion = await fetchLatestVersion(options)
      lastAttemptAt = Date.now()
      state = {
        currentVersion: CURRENT_VERSION ?? null,
        latestVersion,
        updateAvailable: CURRENT_VERSION !== undefined && compareVersions(CURRENT_VERSION, latestVersion) < 0,
        status: 'ok',
        checkedAt: new Date(lastAttemptAt).toISOString(),
        error: null,
      }
    } catch (error) {
      lastAttemptAt = Date.now()
      state = {
        ...state,
        status: 'error',
        checkedAt: new Date(lastAttemptAt).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      inFlight = undefined
    }
    return state
  })()
  return inFlight
}

/**
 * The current state, without touching the network.
 * @returns {UpdateState}
 */
export function snapshot() {
  return {
    ...state,
    upgradeHint: state.updateAvailable ? upgradeHint(state.latestVersion) : null,
  }
}

/**
 * Kick off the boot-time check without waiting for it.
 *
 * Called from the plugin entry point, so the first panel the user opens already has an answer. Any
 * rejection is already folded into the state; this never returns a promise anyone has to handle.
 * @param {object} [options] - forwarded to {@link refreshUpdate}.
 * @returns {void}
 */
export function startAutoCheck(options = {}) {
  if (disabled()) return
  void refreshUpdate(options)
}

/** Reset the module state. Tests only. */
export function resetUpdateStateForTests() {
  state = {
    currentVersion: CURRENT_VERSION ?? null,
    latestVersion: null,
    updateAvailable: false,
    status: 'never',
    checkedAt: null,
    error: null,
  }
  inFlight = undefined
  lastAttemptAt = 0
}

export { compareVersions }