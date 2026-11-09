/**
 * One view of each plugin, shared by everything the page publishes: the rows the HTML shows, the compact
 * `rows.json` the page loads, the per-plugin JSON and its shields badge. Building them from one function is
 * what keeps a badge from saying "boots" while the table says "rejected".
 *
 * Every field that came from a plugin or from a verify run (names, failure details, tool names) is treated as
 * untrusted: it is carried as data and only ever escaped or assigned through `textContent` by the renderers.
 */
import { slugOf } from '../util/slug.js'
import { forecastRow } from './forecast.js'

/** Absolute URL of the page, for links that leave it (badges, per-plugin JSON). */
export const COMPAT_URL = 'https://easonmws.github.io/dsh-plugin-health/compat/'

/** The host a current user runs: the column the headline, badges and forecasts are about. */
export function latestHostOf(matrix) {
  const hosts = matrix.hosts ?? []
  return hosts.find((host) => matrix.hostRoles?.[host] === 'latest') ?? hosts[0]
}

/** YYYY-MM-DD, or '' when absent or unparseable. */
export function dayOf(iso) {
  if (typeof iso !== 'string') return ''
  const day = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : ''
}

/**
 * Per-host state code.
 *   ok   declared, and the declaration admits the host
 *   none no declaration at all: the gate does not check it, which is not the same as passing
 *   bad  the declaration rejects the host
 *   err  the evaluation itself failed
 *   na   not checked on this host
 */
function stateOf(result, declared) {
  if (result === undefined) return 'na'
  if (result.compatible === true) return declared === 'none' ? 'none' : 'ok'
  if (result.compatible === false) return 'bad'
  return 'err'
}

/**
 * @param {object} matrix - from createMatrix (with B6 fields when available).
 * @param {object} [meta]
 * @param {Map<string, {category?: string}>} [meta.catalog]
 * @param {{host: string, rows: Map<string, object>, evidenceBase?: string}} [meta.verify] - verify.json for one host.
 * @param {Map<string, Array<{kind: string, name: string, with: string[]}>>} [meta.conflicts]
 * @param {Map<string, {since?: string, state?: string, lastFixed?: string}>} [meta.history]
 * @returns {Array<object>} one compact row per plugin, sorted by name.
 */
export function buildRows(matrix, meta = {}) {
  const hosts = matrix.hosts ?? []
  const latest = latestHostOf(matrix)
  const catalog = meta.catalog instanceof Map ? meta.catalog : new Map()
  const verifyHost = meta.verify?.host
  const verified = meta.verify?.rows instanceof Map ? meta.verify.rows : new Map()
  const conflicts = meta.conflicts instanceof Map ? meta.conflicts : new Map()
  const history = meta.history instanceof Map ? meta.history : new Map()
  return [...(matrix.plugins ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((plugin) => {
      const entry = catalog.get(plugin.name) ?? {}
      const category = typeof entry.category === 'string' && entry.category !== '' ? entry.category : 'uncategorized'
      const declared = plugin.declared ?? null
      const latestResult = latest === undefined ? undefined : plugin.results?.[latest]
      const hint = latestResult?.fixHint
      const forecast = latest === undefined ? null : forecastRow(plugin, latest)
      const run = verifyHost === latest ? verified.get(plugin.name) : undefined
      // A verify result only describes the version that was run. A newer release on the page is unverified.
      const sameVersion = run !== undefined && (run.version === undefined || run.version === plugin.version)
      const past = history.get(plugin.name)
      const requirements = Object.entries(plugin.results ?? {})
        .flatMap(([host, result]) => Object.entries(result?.requirements ?? {}).map(([field, range]) => `${host}: ${field} ${range}`))
        .slice(0, 6)
      return {
        n: plugin.name,
        slug: slugOf(plugin.name),
        v: plugin.version ?? '',
        ...(plugin.source === 'github' ? { src: 'github' } : {}),
        c: category,
        r: dayOf(plugin.publishedAt),
        d: declared,
        s: hosts.map((host) => stateOf(plugin.results?.[host], declared)),
        bad: plugin.summary?.incompatible ?? 0,
        err: plugin.summary?.errors ?? 0,
        q: (plugin.summary?.incompatible ?? 0) > 0 ? requirements : [],
        h: hint ? { reason: hint.reason, crosses: hint.crossesLine === true, sug: Object.entries(hint.suggested ?? {}) } : null,
        f: forecast?.atRisk ? forecast.rejects : null,
        l: sameVersion ? (run.level ?? null) : null,
        k: sameVersion ? (run.failure?.kind ?? null) : null,
        b: sameVersion && run.bypassed ? (run.bypass?.level ?? null) : null,
        e: sameVersion && typeof run.result === 'string' && meta.verify?.evidenceBase
          ? `${meta.verify.evidenceBase}${run.result}` : null,
        tested: sameVersion,
        x: (conflicts.get(plugin.name) ?? []).slice(0, 5),
        t: past ? { since: past.since ?? null, state: past.state ?? null, fixed: past.lastFixed ?? null } : null,
      }
    })
}

/**
 * The machine-readable record for one plugin: everything the page knows, with links back.
 * @param {object} row - from buildRows.
 * @param {object} plugin - the matrix row.
 * @param {object} matrix
 */
export function pluginDocument(row, plugin, matrix) {
  return {
    schemaVersion: 1,
    generatedAt: matrix.generatedAt,
    name: row.n,
    version: row.v,
    page: `${COMPAT_URL}#p-${row.slug}`,
    source: plugin.source === 'github'
      ? { kind: 'github', note: 'judged from package.json on the default branch; not a published package' }
      : { kind: plugin.source ?? 'npm' },
    declared: plugin.declared ?? null,
    declaredRanges: plugin.declaredRanges ?? null,
    hosts: Object.fromEntries((matrix.hosts ?? []).map((host) => [host, {
      role: matrix.hostRoles?.[host] ?? null,
      ...(plugin.results?.[host] ?? { compatible: null }),
    }])),
    nextBuild: row.f ? { rejects: row.f, forecast: true } : null,
    verify: row.tested ? { host: latestHostOf(matrix), level: row.l, failure: row.k, bypassLevel: row.b, evidence: row.e } : null,
    conflicts: row.x.map((conflict) => ({ ...conflict, predicted: true })),
    history: row.t,
    caveat: 'Declarations and boot checks only. Not a security review; features, API-key paths and the desktop app are not covered.',
  }
}

/**
 * A shields.io endpoint document for the latest host.
 *
 * The message says the strongest thing that is true and no more: "boots" only with a V3 run of this exact
 * version, otherwise what the declaration says.
 */
export function shieldsDocument(row, matrix) {
  const latest = latestHostOf(matrix)
  const index = (matrix.hosts ?? []).indexOf(latest)
  const state = index >= 0 ? row.s[index] : 'na'
  let message
  let color
  if (state === 'bad') {
    message = row.b === 'V3' ? 'rejected · boots if exempted' : 'rejected'
    color = row.b === 'V3' ? 'orange' : 'red'
  } else if (state === 'ok' && row.l === 'V3') {
    message = row.f ? 'boots · next build rejects' : 'boots'
    color = row.f ? 'yellow' : 'brightgreen'
  } else if (state === 'ok') {
    message = row.f ? 'accepted · next build rejects' : 'accepted'
    color = row.f ? 'yellow' : 'green'
  } else if (state === 'none') {
    message = 'undeclared'
    color = 'lightgrey'
  } else {
    message = 'unknown'
    color = 'lightgrey'
  }
  return { schemaVersion: 1, label: `dsh ${latest ?? ''}`.trim(), message, color }
}
