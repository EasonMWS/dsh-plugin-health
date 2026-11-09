/**
 * Batch verification: for each plugin, how far it gets on one host, with evidence for every step.
 *
 *   V1  its declaration admits the host (the same evaluation the host's install gate runs)
 *   V2  the official CLI installed it into a clean profile
 *   V3  after boot, every entry of the plugin is active
 *
 * None of these is a security review, and V3 does not mean the plugin's features work. A plugin that fails V1
 * is still run once with the exact-version exemption inside the throwaway home, because "rejected by its
 * declaration" and "broken" are different findings; that run is recorded as `bypass` and never raises the
 * level.
 *
 * Every run uses the clean environment: this executes code nobody here has read.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { evaluatePluginCompatibility } from '../compat/evaluate.js'
import { mapLimit, resolvePlugins } from '../compat/matrix.js'
import { toolIdentity } from './evidence.js'
import { slugOf } from '../util/slug.js'
import { runHostBaseline, runRuntimeSmoke } from './smoke.js'

export const LEVELS = Object.freeze(['V1', 'V2', 'V3'])

/**
 * Official bundles every trial profile gets, from the host's own install. A plain `plugin add` profile lacks
 * the web app, and plugins that wait for its services (webServer, connection, workspaceRegistry) looked broken
 * when every real user has them: 80 of the top 250 on 2026-11-09.
 */
export const DEFAULT_HOST_BUNDLES = Object.freeze(['@deepseek-ai/dsh-web-app'])

export { slugOf } from '../util/slug.js'

/** Parse `i/n` (1-based). */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/u.exec(String(text ?? '').trim())
  if (!match) throw new Error('--shard must look like 3/10')
  const index = Number(match[1])
  const count = Number(match[2])
  if (count < 1 || index < 1 || index > count) throw new Error('--shard needs 1 <= i <= n')
  return { index, count }
}

/**
 * Which shard a plugin belongs to. A hash of the name, not its position in the list, so adding one plugin to
 * the catalogue does not reshuffle every other plugin into a different shard (and a different cache runner).
 */
export function shardOf(name, count) {
  const value = Number.parseInt(createHash('sha256').update(String(name)).digest('hex').slice(0, 8), 16)
  return (value % count) + 1
}

/** Results are reusable only for the same bytes, the same host, and a tool whose rules have not changed. */
export function cacheKey({ name, version, integrity, host, toolVersion }) {
  const toolLine = String(toolVersion ?? '').split('.').slice(0, 2).join('.')
  return createHash('sha256').update([`${name}@${version}`, integrity ?? '', host, toolLine].join('|')).digest('hex')
}

/** How far a smoke report got. */
export function levelOf(report, declared) {
  if (!declared) return null
  if (report?.ok === true) return 'V3'
  if (report?.stages?.some((stage) => stage.name === 'install' && stage.ok === true)) return 'V2'
  return 'V1'
}

/** The part of a footprint the host did not already have. */
export function footprintDelta(footprint, baseline) {
  if (!footprint) return null
  const known = new Set((baseline?.entries ?? []).map((entry) => `${entry.id}\u0000${entry.name}`))
  const knownTools = new Set(baseline?.tools ?? [])
  return {
    entries: (footprint.entries ?? []).filter((entry) => !known.has(`${entry.id}\u0000${entry.name}`)),
    tools: (footprint.tools ?? []).filter((tool) => !knownTools.has(tool)),
    toolsUnavailable: footprint.toolsUnavailable === true,
    baseline: baseline ? 'host' : 'none',
  }
}

/**
 * Collisions that would appear if these plugins were installed together, predicted from each one's footprint
 * delta. Nothing was installed together, so every row says `predicted: true`.
 *
 * @param {Array<{name: string, version: string, footprint?: {entries: Array<{id: string|null}>, tools: string[]}|null}>} rows
 * @returns {Array<{kind: 'tool-name'|'entry-id', name: string, plugins: string[], predicted: true}>}
 */
export function predictConflicts(rows) {
  const owners = { 'tool-name': new Map(), 'entry-id': new Map() }
  for (const row of rows) {
    if (!row?.footprint) continue
    const label = `${row.name}@${row.version}`
    const claim = (kind, key) => {
      if (typeof key !== 'string' || key === '') return
      const set = owners[kind].get(key) ?? new Set()
      set.add(label)
      owners[kind].set(key, set)
    }
    for (const tool of row.footprint.tools ?? []) claim('tool-name', tool)
    for (const entry of row.footprint.entries ?? []) claim('entry-id', entry.id)
  }
  const conflicts = []
  for (const kind of ['tool-name', 'entry-id']) {
    for (const [name, set] of [...owners[kind]].sort(([a], [b]) => a.localeCompare(b))) {
      if (set.size > 1) conflicts.push({ kind, name, plugins: [...set].sort(), predicted: true })
    }
  }
  return conflicts
}

/** Failure for a plugin that never reached a run. */
function resolveFailure(message) {
  const kind = /not published|cannot resolve a version|404|not found/iu.test(message) ? 'not-found'
    : /ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed/u.test(message) ? 'network' : 'unknown'
  return { stage: 'resolve', kind, detail: message.slice(0, 300) }
}

/**
 * @param {object} options
 * @param {string} options.dshDirectory - installed `@deepseek-ai/dsh`.
 * @param {string[]} options.plugins - specs (`name`, `name@version`).
 * @param {string} options.out - output directory.
 * @param {number} [options.concurrency]
 * @param {{index: number, count: number}} [options.shard]
 * @param {string} [options.cache] - directory of reusable results.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.installTimeoutMs]
 * @param {string} [options.registry]
 * @param {object} [deps] - injectable for tests.
 */
export async function runVerify({
  dshDirectory, plugins, out, concurrency = 2, shard, cache, timeoutMs = 60_000, installTimeoutMs = 180_000, registry,
  // What every trial profile contains besides dsh-base: by default what a web or desktop profile has.
  hostBundles = DEFAULT_HOST_BUNDLES,
}, {
  resolvePlugin = async (spec) => (await resolvePlugins([spec], registry ? { registry } : {}))[0],
  smoke = runRuntimeSmoke,
  baseline: runBaseline = runHostBaseline,
  now = () => new Date(),
} = {}) {
  if (typeof dshDirectory !== 'string' || dshDirectory === '') throw new Error('verify requires --dsh-dir')
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('verify requires --plugins')
  if (typeof out !== 'string' || out === '') throw new Error('verify requires --out')
  const host = JSON.parse(readFileSync(join(resolve(dshDirectory), 'package.json'), 'utf8')).version
  const tool = toolIdentity()
  const outDirectory = resolve(out)
  const resultsDirectory = join(outDirectory, 'results')
  const runsDirectory = join(outDirectory, 'runs')
  mkdirSync(resultsDirectory, { recursive: true })
  if (cache) mkdirSync(resolve(cache), { recursive: true })

  const selected = [...new Set(plugins)]
    .sort((a, b) => a.localeCompare(b))
    .filter((spec) => !shard || shardOf(spec.replace(/(?<=.)@[^@/]*$/u, ''), shard.count) === shard.index)

  // The baseline is per host and per tool line; cache it like any other result.
  // A result depends on what else was in the profile, so the composition is part of every cache key.
  const hostKey = hostBundles.length > 0 ? `${host}+${[...hostBundles].sort().join(',')}` : host
  const baselineKey = cacheKey({ name: '<host-baseline>', version: host, integrity: '', host: hostKey, toolVersion: tool.version })
  const baselinePath = cache ? join(resolve(cache), `${baselineKey}.json`) : null
  let baseline = baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
  if (!baseline) {
    baseline = await runBaseline({ dshDirectory, out: runsDirectory, timeoutMs, installTimeoutMs, hostBundles })
    if (baselinePath && baseline?.footprint) writeFileSync(baselinePath, JSON.stringify(baseline))
  }

  const rows = await mapLimit(selected, concurrency, async (spec) => {
    let resolved
    try {
      resolved = await resolvePlugin(spec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { name: spec, version: null, integrity: null, level: null, failure: resolveFailure(message), result: null }
    }
    const integrity = resolved.manifest?.dist?.integrity ?? null
    const key = cacheKey({ name: resolved.name, version: resolved.version, integrity, host: hostKey, toolVersion: tool.version })
    const cachePath = cache ? join(resolve(cache), `${key}.json`) : null
    const slug = slugOf(resolved.name)
    const resultFile = `results/${slug}.json`
    if (cachePath && existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      writeFileSync(join(outDirectory, resultFile), `${JSON.stringify(cached.detail, null, 2)}\n`)
      return { ...cached.row, cached: true }
    }

    let declared = false
    let declarationError = null
    try {
      declared = evaluatePluginCompatibility(resolved.manifest, { runtimeVersion: host }) === undefined
    } catch (error) {
      declarationError = error instanceof Error ? error.message : String(error)
    }
    const common = {
      dshDirectory, plugin: `${resolved.name}@${resolved.version}`, pluginName: resolved.name, pluginVersion: resolved.version,
      registryOnly: true, bootOnly: true, cleanEnv: true, out: runsDirectory, timeoutMs, installTimeoutMs, hostBundles,
    }
    const report = await smoke({ ...common, bypassGate: !declared })
    const level = levelOf(report, declared)
    const footprint = footprintDelta(report.stages?.find((stage) => stage.name === 'runtime')?.details?.footprint, baseline?.footprint)
    const row = {
      name: resolved.name, version: resolved.version, integrity,
      level,
      declared,
      ...(declarationError ? { declarationError } : {}),
      ...(declared ? {} : { bypassed: true, bypass: { level: report.ok ? 'V3' : levelOf(report, true), failure: report.failure ?? null } }),
      failure: declared ? (report.failure ?? null) : { stage: 'declaration', kind: 'gate-rejected', detail: 'the declared range does not admit this host' },
      footprint,
      result: resultFile,
    }
    const detail = { ...report, level, declared, footprintDelta: footprint, ...(row.bypass ? { bypassed: true, bypass: row.bypass } : {}) }
    writeFileSync(join(outDirectory, resultFile), `${JSON.stringify(detail, null, 2)}\n`)
    if (cachePath) writeFileSync(cachePath, JSON.stringify({ row, detail }))
    return row
  })

  const counts = { V1: 0, V2: 0, V3: 0, none: 0, failures: {} }
  for (const row of rows) {
    if (row.level) counts[row.level] += 1
    else counts.none += 1
    if (row.failure) counts.failures[row.failure.kind] = (counts.failures[row.failure.kind] ?? 0) + 1
  }
  const document = {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    tool,
    host: { version: host },
    profile: { base: '@deepseek-ai/dsh-base', hostBundles: [...hostBundles] },
    ...(shard ? { shard } : {}),
    baseline: baseline?.footprint
      ? { entries: baseline.footprint.entries.length, tools: baseline.footprint.tools.length }
      : { error: baseline?.error ?? 'no baseline' },
    counts,
    plugins: rows.map(({ footprint, ...row }) => ({ ...row, footprint: footprint ? { entries: footprint.entries.length, tools: footprint.tools } : null })),
    conflicts: predictConflicts(rows),
  }
  writeFileSync(join(outDirectory, 'verify.json'), `${JSON.stringify(document, null, 2)}\n`)
  return document
}
