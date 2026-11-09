/**
 * Everything the compatibility page publishes next to its HTML:
 *
 *   rows.json               the full table, loaded by the page after first paint
 *   p/<slug>.json           one plugin: declarations, verdicts, forecast, boot test, history
 *   shields/<slug>.json     a shields.io endpoint, so an author can put the verdict in their README
 *
 * and the two inputs that make the page more than a declaration table: a verify run for the latest host, and
 * the history directory that accumulates one snapshot a day.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { diffSnapshots, snapshotOf, summarizeHistory } from './history.js'
import { renderCompatPage } from './page.js'
import { buildRows, pluginDocument, shieldsDocument } from './rows.js'

/** Upper bound for any JSON read from a verify run or the history branch: they are produced elsewhere. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

function readJson(path) {
  const text = readFileSync(path, 'utf8')
  if (text.length > MAX_JSON_BYTES) throw new Error(`${path} is larger than ${MAX_JSON_BYTES} bytes`)
  return JSON.parse(text)
}

/** `name@version` → name, scoped names included. */
function nameOfLabel(label) {
  const at = String(label).lastIndexOf('@')
  return at > 0 ? label.slice(0, at) : String(label)
}

/**
 * Load a verify run (verify.json from the `verify` command) into the shape the rows expect.
 *
 * The file is produced by a job that executed third-party code, so it is validated rather than trusted: rows
 * without a string name are dropped, levels outside V1–V3 become null, and only known fields are kept.
 *
 * @param {string} path - verify.json.
 * @param {{evidenceBase?: string}} [options] - URL prefix for `results/<slug>.json`, relative to the page.
 * @returns {{verify: {host: string, rows: Map, evidenceBase: string}, conflicts: Map}}
 */
export function loadVerify(path, { evidenceBase } = {}) {
  const document = readJson(path)
  const host = typeof document?.host?.version === 'string' ? document.host.version : null
  if (!host) throw new Error(`${path} has no host.version`)
  const levels = new Set(['V1', 'V2', 'V3'])
  const rows = new Map()
  for (const row of Array.isArray(document.plugins) ? document.plugins : []) {
    if (typeof row?.name !== 'string' || row.name === '') continue
    rows.set(row.name, {
      version: typeof row.version === 'string' ? row.version : undefined,
      level: levels.has(row.level) ? row.level : null,
      failure: typeof row.failure?.kind === 'string' ? { kind: row.failure.kind.replace(/[^a-z-]/gu, '').slice(0, 40) } : null,
      bypassed: row.bypassed === true,
      bypass: row.bypassed === true ? { level: levels.has(row.bypass?.level) ? row.bypass.level : null } : undefined,
      result: typeof row.result === 'string' && /^results\/[a-z0-9._-]+\.json$/u.test(row.result) ? row.result : undefined,
    })
  }
  const conflicts = new Map()
  for (const conflict of Array.isArray(document.conflicts) ? document.conflicts : []) {
    if (!['tool-name', 'entry-id'].includes(conflict?.kind) || typeof conflict.name !== 'string' || !Array.isArray(conflict.plugins)) continue
    const names = conflict.plugins.filter((label) => typeof label === 'string').map(nameOfLabel)
    for (const name of names) {
      const list = conflicts.get(name) ?? []
      list.push({ kind: conflict.kind, name: conflict.name.slice(0, 120), with: names.filter((other) => other !== name).slice(0, 5) })
      conflicts.set(name, list)
    }
  }
  return { verify: { host, rows, evidenceBase: evidenceBase ?? `../verify/${host}/` }, conflicts }
}

/**
 * Record today's snapshot in a history directory and return every event so far.
 *
 * Layout: `<dir>/snapshots/<YYYY-MM-DD>.json` and `<dir>/events.json`. Running twice on one day replaces that
 * day's snapshot and does not duplicate its events.
 *
 * @param {object} matrix
 * @param {string} directory
 * @param {{date?: string}} [options]
 * @returns {{events: object[], summary: Map, previous: string|null, added: number}}
 */
export function updateHistory(matrix, directory, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const snapshots = join(directory, 'snapshots')
  mkdirSync(snapshots, { recursive: true })
  const earlier = readdirSync(snapshots)
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(file) && file.slice(0, 10) < date)
    .sort()
  const previousName = earlier.at(-1) ?? null
  const previous = previousName ? readJson(join(snapshots, previousName)) : null
  const current = snapshotOf(matrix, date)
  writeFileSync(join(snapshots, `${date}.json`), JSON.stringify(current))
  const eventsPath = join(directory, 'events.json')
  const existing = existsSync(eventsPath) ? readJson(eventsPath) : []
  const kept = (Array.isArray(existing) ? existing : []).filter((event) => event?.date !== date)
  const fresh = diffSnapshots(previous, current)
  const events = [...kept, ...fresh].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  writeFileSync(eventsPath, `${JSON.stringify(events)}\n`)
  return { events, summary: summarizeHistory(events), previous: previousName?.slice(0, 10) ?? null, added: fresh.length }
}

/**
 * Write the page and everything it links to.
 * @param {object} matrix
 * @param {string} out - directory that becomes `/compat/`.
 * @param {object} meta - page meta, plus verify/conflicts/history from the loaders above.
 * @returns {{rows: number, documents: number}}
 */
export function writeCompatSite(matrix, out, meta = {}) {
  const rows = buildRows(matrix, meta)
  mkdirSync(join(out, 'p'), { recursive: true })
  mkdirSync(join(out, 'shields'), { recursive: true })
  writeFileSync(join(out, 'rows.json'), JSON.stringify(rows))
  const byName = new Map((matrix.plugins ?? []).map((plugin) => [plugin.name, plugin]))
  for (const row of rows) {
    const plugin = byName.get(row.n)
    writeFileSync(join(out, 'p', `${row.slug}.json`), `${JSON.stringify(pluginDocument(row, plugin, matrix), null, 2)}\n`)
    writeFileSync(join(out, 'shields', `${row.slug}.json`), JSON.stringify(shieldsDocument(row, matrix)))
  }
  writeFileSync(join(out, 'index.html'), renderCompatPage(matrix, { ...meta, rows }))
  return { rows: rows.length, documents: rows.length }
}
