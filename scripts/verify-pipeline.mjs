/**
 * The non-executing halves of the batch verification workflow (`.github/workflows/verify-runtime.yml`):
 *
 *   detect  did the host move since the last recorded run? which hosts to test?
 *   plan    which plugins: the most-downloaded ones the latest host accepts, plus a smaller set it rejects
 *   merge   validate shard outputs (produced by a job that ran third-party code) and combine them
 *
 * None of these run plugin code. `merge` treats every file it reads as hostile: structure checked, size
 * capped, logs truncated, paths constrained.
 *
 * Usage:
 *   node scripts/verify-pipeline.mjs detect <state.json|-> [--force]
 *   node scripts/verify-pipeline.mjs plan <matrix.json> <catalog.json> <host> <top> <out.txt>
 *   node scripts/verify-pipeline.mjs merge <host> <out-dir> <shard-dir>...
 * @module scripts/verify-pipeline
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCurrentHosts } from '../src/compat/matrix.js'
import { predictConflicts } from '../src/runtime/verify.js'

const MAX_RESULT_BYTES = 1024 * 1024
const MAX_LOG_CHARS = 16 * 1024
const LEVELS = new Set(['V1', 'V2', 'V3'])

/**
 * @param {object} packument - the registry document for @deepseek-ai/dsh.
 * @param {{hosts?: string[]}|null} state - last recorded run.
 * @param {{force?: boolean}} [options] - a scheduled full re-run (weekly) or a manual one.
 * @returns {{changed: boolean, hosts: string[], latest: string|null}}
 */
export function detect(packument, state, { force = false } = {}) {
  const selection = selectCurrentHosts(packument)
  const hosts = selection.hosts
  const latest = Object.entries(selection.roles ?? {}).find(([, role]) => role === 'latest')?.[0] ?? hosts[0] ?? null
  const before = Array.isArray(state?.hosts) ? [...state.hosts].sort().join(',') : ''
  return { changed: force || before !== [...hosts].sort().join(','), hosts, latest }
}

/**
 * Pick plugins to boot-test: the `top` most-downloaded plugins the latest host accepts, and a quarter as many
 * that it rejects. The rejected ones are what tell a stale declaration from broken code.
 *
 * @param {object} matrix - compat/matrix.json.
 * @param {object} catalog - the community catalog, for download counts.
 * @param {string} host - latest host.
 * @param {number} top
 * @returns {string[]} `name@version` specs.
 */
export function plan(matrix, catalog, host, top) {
  const downloads = new Map()
  for (const entry of catalog?.plugins ?? []) {
    if (typeof entry?.npm === 'string') downloads.set(entry.npm, Number(entry.downloads) || 0)
  }
  const byDownloads = (a, b) => (downloads.get(b.name) ?? 0) - (downloads.get(a.name) ?? 0) || a.name.localeCompare(b.name)
  // A GitHub-only row was judged from a default branch; there is no published package to install and boot.
  const rows = (matrix?.plugins ?? []).filter((row) => typeof row?.name === 'string' && typeof row.version === 'string' && row.source !== 'github')
  const accepted = rows.filter((row) => row.results?.[host]?.compatible === true).sort(byDownloads).slice(0, top)
  const rejected = rows.filter((row) => row.results?.[host]?.compatible === false).sort(byDownloads).slice(0, Math.ceil(top / 4))
  return [...accepted, ...rejected].map((row) => `${row.name}@${row.version}`)
}

/** Keep a log field readable and bounded. */
function truncate(text) {
  if (typeof text !== 'string') return text
  return text.length > MAX_LOG_CHARS ? `…[truncated ${text.length - MAX_LOG_CHARS} chars]…${text.slice(-MAX_LOG_CHARS)}` : text
}

/** Validate and shrink one results/<slug>.json. Returns null when it is not a result at all. */
export function sanitizeResult(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.stages)) return null
  const clean = { ...document }
  clean.stages = document.stages.slice(0, 20).map((stage) => ({
    ...stage,
    stdout: truncate(stage?.stdout),
    stderr: truncate(stage?.stderr),
    ...(stage?.details ? { details: { ...stage.details, error: truncate(stage.details.error) } } : {}),
  }))
  if (typeof clean.error === 'string') clean.error = truncate(clean.error)
  return clean
}

/** One plugin row from a shard's verify.json, with only known fields of known types. */
function sanitizeRow(row) {
  if (typeof row?.name !== 'string' || row.name === '' || row.name.length > 214) return null
  return {
    name: row.name,
    version: typeof row.version === 'string' ? row.version.slice(0, 64) : null,
    integrity: typeof row.integrity === 'string' ? row.integrity.slice(0, 200) : null,
    level: LEVELS.has(row.level) ? row.level : null,
    declared: row.declared === true,
    ...(row.bypassed === true ? { bypassed: true, bypass: { level: LEVELS.has(row.bypass?.level) ? row.bypass.level : null } } : {}),
    failure: typeof row.failure?.kind === 'string' ? { stage: String(row.failure.stage ?? '').slice(0, 40), kind: row.failure.kind.replace(/[^a-z-]/gu, '').slice(0, 40), detail: String(row.failure.detail ?? '').slice(0, 300) } : null,
    result: typeof row.result === 'string' && /^results\/[a-z0-9._-]+\.json$/u.test(row.result) ? row.result : null,
  }
}

/**
 * Combine shard outputs into one verify.json and one results/ directory for a host.
 * @param {string} host
 * @param {string} out - destination, e.g. verify/<host>.
 * @param {string[]} shards - directories each holding a shard's verify.json and results/.
 * @returns {object} the merged document.
 */
export function merge(host, out, shards) {
  const results = join(out, 'results')
  mkdirSync(results, { recursive: true })
  const rows = new Map()
  const footprints = []
  let tool = null
  let profile = null
  const rejected = []
  for (const shard of shards) {
    const path = join(shard, 'verify.json')
    if (!existsSync(path)) continue
    if (statSync(path).size > 16 * MAX_RESULT_BYTES) { rejected.push(`${path}: too large`); continue }
    let document
    try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { rejected.push(`${path}: ${error.message}`); continue }
    if (document?.host?.version !== host) { rejected.push(`${path}: host ${document?.host?.version} is not ${host}`); continue }
    // Only official bundle names survive: this came from the job that ran plugin code.
    profile ??= Array.isArray(document.profile?.hostBundles)
      ? { base: '@deepseek-ai/dsh-base', hostBundles: document.profile.hostBundles.filter((name) => typeof name === 'string' && /^@deepseek-ai\/dsh-[a-z0-9-]+$/u.test(name)) }
      : null
    tool ??= document.tool && typeof document.tool.version === 'string' ? { name: 'dsh-plugin-health', version: document.tool.version.slice(0, 32) } : null
    for (const raw of Array.isArray(document.plugins) ? document.plugins : []) {
      const row = sanitizeRow(raw)
      if (!row) continue
      if (row.result) {
        const source = join(shard, row.result)
        if (existsSync(source) && statSync(source).size <= 4 * MAX_RESULT_BYTES) {
          try {
            const detail = sanitizeResult(JSON.parse(readFileSync(source, 'utf8')))
            if (detail) {
              const text = JSON.stringify(detail, null, 2)
              writeFileSync(join(out, row.result), `${text.length > MAX_RESULT_BYTES ? JSON.stringify(detail) : text}\n`)
              const delta = detail.footprintDelta
              if (delta && Array.isArray(delta.tools) && Array.isArray(delta.entries)) {
                footprints.push({ name: row.name, version: row.version, footprint: { tools: delta.tools.filter((tool) => typeof tool === 'string'), entries: delta.entries.filter((entry) => typeof entry?.id === 'string') } })
              }
            } else row.result = null
          } catch { row.result = null }
        } else row.result = null
      }
      rows.set(row.name, row)
    }
  }
  const plugins = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  const counts = { V1: 0, V2: 0, V3: 0, none: 0, failures: {} }
  for (const row of plugins) {
    if (row.level) counts[row.level] += 1
    else counts.none += 1
    if (row.failure) counts.failures[row.failure.kind] = (counts.failures[row.failure.kind] ?? 0) + 1
  }
  const document = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), tool, host: { version: host },
    ...(profile ? { profile } : {}),
    counts, plugins, conflicts: predictConflicts(footprints), ...(rejected.length ? { rejectedInputs: rejected } : {}),
  }
  writeFileSync(join(out, 'verify.json'), `${JSON.stringify(document, null, 2)}\n`)
  return document
}

async function main([command, ...args]) {
  if (command === 'detect') {
    const [statePath, flag] = args
    // A constant command; on Windows npm is a .cmd shim, which only a shell can start, so it is passed as one string.
    const view = 'npm view @deepseek-ai/dsh --json dist-tags versions time'
    const packument = JSON.parse(process.platform === 'win32'
      ? execFileSync(view, { encoding: 'utf8', shell: true })
      : execFileSync('npm', view.split(' ').slice(1), { encoding: 'utf8' }))
    const document = { 'dist-tags': packument['dist-tags'], versions: Object.fromEntries((packument.versions ?? []).map((version) => [version, {}])), time: packument.time }
    const state = statePath && statePath !== '-' && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
    const result = detect(document, state, { force: flag === '--force' })
    console.log(JSON.stringify(result))
    return
  }
  if (command === 'plan') {
    const [matrixPath, catalogPath, host, top, outPath] = args
    const specs = plan(JSON.parse(readFileSync(matrixPath, 'utf8')), JSON.parse(readFileSync(catalogPath, 'utf8')), host, Number(top) || 200)
    writeFileSync(outPath, `${specs.join('\n')}\n`)
    console.log(`planned ${specs.length} plugins for ${host}`)
    return
  }
  if (command === 'merge') {
    const [host, out, ...shards] = args
    const shardDirs = shards.flatMap((dir) => (existsSync(join(dir, 'verify.json')) ? [dir] : readdirSync(dir).map((name) => join(dir, name))))
    const document = merge(host, resolve(out), shardDirs)
    console.log(`merged ${document.plugins.length} plugins for ${host}: V3 ${document.counts.V3}, V2 ${document.counts.V2}, V1 ${document.counts.V1}, none ${document.counts.none}`)
    return
  }
  throw new Error('usage: verify-pipeline.mjs detect|plan|merge …')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
