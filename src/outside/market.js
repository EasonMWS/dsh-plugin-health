/**
 * Read a plugin market index and judge every entry against a DSH version.
 *
 * The point of this module: a market tells you what exists, and this tells you what will actually load. A
 * user about to install something from a market should be able to see "these 12 of 40 will be rejected by
 * the host you are running" before they install anything.
 *
 * What it does NOT do is install. Two reasons, and both are measured rather than cautious:
 *
 *   1. Installing runs a package manager, which executes whatever postinstall scripts the package ships.
 *      On Windows there is no sandbox available to put that in — verified, not assumed.
 *   2. DSH already owns installation. A second implementation would mean two sources of truth for what a
 *      profile looks like, and they would drift.
 *
 * So this emits the exact install spec as text, for the user to run where the decision belongs.
 *
 * The format is DSH's own: `parseMarketIndex` from `@deepseek-ai/dsh-plugin-market-index` is used rather
 * than a local reimplementation, so a change to format 1 is a dependency update here, not a divergence.
 * @module outside/market
 */

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { satisfiesDshRange } from '../compat/evaluate.js'

/** A market index larger than this is not a market index; refuse rather than parse it. */
const MAX_INDEX_BYTES = 8 * 1024 * 1024

/** Fetch timeout. A market that hangs must not hang the manager. */
const FETCH_TIMEOUT_MS = 20_000

/**
 * The official parser, loaded lazily so a missing optional dependency is a clear error rather than a crash
 * at import time elsewhere.
 * @returns {Promise<{parseMarketIndex: Function, marketInstallTarget: Function}>}
 */
async function officialParser() {
  const module = await import('@deepseek-ai/dsh-plugin-market-index')
  if (typeof module.parseMarketIndex !== 'function') {
    throw new Error('@deepseek-ai/dsh-plugin-market-index does not export parseMarketIndex')
  }
  return module
}

/**
 * A file: URL for a local path, so the official parser gets an absolute URL for relative icon resolution.
 * @param {string} path
 * @returns {string}
 */
function fileUrl(path) {
  return pathToFileURL(path).href
}

/**
 * Read a market index from a URL or a local file.
 *
 * @param {string} source - an https URL, or a path to a JSON file.
 * @param {{fetch?: typeof fetch, readFile?: (path: string) => string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, market: object, source: string} | {ok: false, error: string}>}
 */
export async function loadMarket(source, { fetch: fetchImpl = globalThis.fetch, readFile = (path) => readFileSync(path, 'utf8'), timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof source !== 'string' || source.trim() === '') return { ok: false, error: 'a market source is required' }
  const trimmed = source.trim()

  let text
  let indexUrl

  if (/^https?:\/\//iu.test(trimmed)) {
    indexUrl = trimmed
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'this runtime has no fetch' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(trimmed, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (response.ok !== true) return { ok: false, error: `the market answered ${response.status}` }
      const length = Number(response.headers?.get?.('content-length') ?? 0)
      if (Number.isFinite(length) && length > MAX_INDEX_BYTES) {
        return { ok: false, error: `the market index is ${Math.round(length / 1048576)} MB, which is too large to read` }
      }
      text = await response.text()
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      return { ok: false, error: aborted ? `the market did not answer within ${Math.round(timeoutMs / 1000)}s` : (error instanceof Error ? error.message : String(error)) }
    } finally {
      clearTimeout(timer)
    }
  } else {
    // A local file: either an index someone saved, or one this tool generated.
    if (!existsSync(trimmed)) return { ok: false, error: `no such file: ${trimmed}` }
    indexUrl = fileUrl(trimmed)
    try {
      text = readFile(trimmed)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (text.length > MAX_INDEX_BYTES) return { ok: false, error: 'the market index is too large to read' }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `the market index is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  let parser
  try {
    parser = await officialParser()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  try {
    const market = parser.parseMarketIndex(document, indexUrl)
    return { ok: true, market, source: trimmed }
  } catch (error) {
    // The official parser says which JSON path is wrong, which is the most useful message we can give.
    const at = typeof error?.path === 'string' ? ` at ${error.path}` : ''
    return { ok: false, error: `the market index does not match format 1${at}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Pick the version of a plugin that a given host would load.
 *
 * Versions arrive newest first from the parser. The best choice is the newest one whose `engines.dsh` admits
 * the target; when a version declares no `engines.dsh` it admits nothing, because that is what the host
 * itself will conclude — a missing engines field is not a wildcard.
 *
 * @param {Array<{version: string, engines?: {dsh?: string}, source: object}>} versions
 * @param {string|undefined} version
 * @returns {{state: 'compatible'|'incompatible'|'unknown', version?: object, reason: string}}
 */
export function bestVersionFor(versions, version) {
  if (version === undefined || version === '') return { state: 'unknown', reason: 'no DSH version was given' }
  if (!Array.isArray(versions) || versions.length === 0) return { state: 'unknown', reason: 'the market entry lists no versions' }

  // Newest that admits the target.
  for (const entry of versions) {
    const range = entry?.engines?.dsh
    if (typeof range !== 'string' || range === '') continue
    if (satisfiesDshRange(version, range)) return { state: 'compatible', version: entry, reason: `declares ${range}` }
  }

  const newest = versions[0]
  const range = newest?.engines?.dsh
  return {
    state: 'incompatible',
    reason: typeof range === 'string' && range !== ''
      ? `newest version ${newest.version} declares ${range}, which excludes ${version}`
      : `newest version ${newest?.version ?? '?'} declares no engines.dsh, so the host will not accept it`,
  }
}

/**
 * Judge a whole market against a DSH version.
 *
 * @param {{market: object, source?: string, runtimeVersion?: string, targetVersion?: string, installed?: Array<{name: string, version: string|null}>}} options
 * @returns {object}
 */
export function judgeMarket({ market, source, runtimeVersion, targetVersion, installed = [] }) {
  const version = targetVersion !== undefined && targetVersion !== '' ? targetVersion : runtimeVersion
  const installedByName = new Map((installed ?? []).map((row) => [row.name, row]))

  const rows = (market?.plugins ?? []).map((plugin) => {
    const best = bestVersionFor(plugin.versions, version)
    const have = installedByName.get(plugin.name)
    const latest = plugin.versions?.[0]

    return {
      name: plugin.name,
      // A localized title is a map keyed by language; English is what the parser guarantees.
      title: localized(plugin.title) ?? plugin.name,
      description: localized(plugin.description) ?? '',
      author: typeof plugin.author === 'string' ? plugin.author : undefined,
      homepage: typeof plugin.homepage === 'string' ? plugin.homepage : undefined,
      categories: Array.isArray(plugin.metadata?.keywords) ? plugin.metadata.keywords.slice(0, 6) : [],
      verdict: best.state,
      reason: best.reason,
      usableVersion: best.version?.version ?? null,
      latestVersion: typeof latest?.version === 'string' ? latest.version : null,
      installedVersion: have?.version ?? null,
      installed: have !== undefined,
      // Reported as text, never offered as a button: installing is DSH's decision, not this tool's.
      installSpec: best.version === undefined ? null : `${plugin.name}@${best.version.version}`,
    }
  })

  rows.sort((left, right) => {
    // Things the host would reject first: those are what the user needs to see.
    const rank = { incompatible: 0, unknown: 1, compatible: 2 }
    const delta = (rank[left.verdict] ?? 3) - (rank[right.verdict] ?? 3)
    return delta !== 0 ? delta : left.name.localeCompare(right.name)
  })

  const counts = { compatible: 0, incompatible: 0, unknown: 0 }
  for (const row of rows) counts[row.verdict] += 1

  return {
    schemaVersion: 1,
    source: source ?? null,
    title: localized(market?.title) ?? null,
    judgedAgainst: version ?? null,
    counts,
    total: rows.length,
    installedCount: rows.filter((row) => row.installed).length,
    plugins: rows,
    limits: [
      'declarations-only',
      'engines.dsh-is-what-the-host-checks',
      'no-install-performed',
    ],
  }
}

/**
 * A localized value: either a plain string or a language map, English preferred.
 * @param {unknown} value
 * @returns {string|undefined}
 */
function localized(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.en === 'string') return value.en
  for (const member of Object.values(value)) {
    if (typeof member === 'string') return member
  }
  return undefined
}