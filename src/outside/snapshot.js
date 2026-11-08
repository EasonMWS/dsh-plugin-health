/**
 * Snapshots of a profile, so a change can be undone when the host will not start.
 *
 * The other half of this tool already takes a backup before it writes anything, but that only covers
 * writes it made itself. A profile also changes when a user installs a plugin, edits a patch by hand,
 * or when the host rewrites its own configuration — and none of those leave a backup behind.
 *
 * Kept deliberately small: configuration files and the patch layers, not node_modules. Restoring a
 * dependency tree from a copy is slow, large, and not what people need when they say "put it back the
 * way it was"; reinstalling does that better.
 * @module outside/snapshot
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

/** Files worth keeping. A profile's behaviour lives in these, not in the packages. */
const CAPTURED = [
  'package.json',
  'cordis.patch.yml',
  'compatibility.json',
  'dsh.profile.json',
  'pnpm-workspace.yaml',
]

/** Keep this many; older ones are removed so a long-lived install does not fill the disk. */
const KEEP = 20

/**
 * @param {string} home
 * @returns {string}
 */
export function snapshotRoot(home) {
  return join(home, '.plugin-health', 'snapshots')
}

/**
 * A stable identifier for a snapshot directory.
 * @param {Date} now
 */
function stamp(now) {
  return now.toISOString().replace(/[:.]/gu, '-')
}

/**
 * Take a snapshot of the profile's configuration files.
 *
 * @param {string} home
 * @param {string} profile
 * @param {{reason?: string, now?: Date}} [options]
 * @returns {{ok: true, id: string, files: string[], directory: string} | {ok: false, error: string}}
 */
export function takeSnapshot(home, profile, { reason = 'manual', now = new Date() } = {}) {
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) return { ok: false, error: `no profile at ${profileDir}` }

  const id = stamp(now)
  const directory = join(snapshotRoot(home), id)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    return { ok: false, error: `cannot create snapshot directory: ${error instanceof Error ? error.message : String(error)}` }
  }

  const files = []
  for (const name of CAPTURED) {
    const source = join(profileDir, name)
    if (!existsSync(source)) continue
    try {
      copyFileSync(source, join(directory, name))
      files.push(name)
    } catch (error) {
      // A partial snapshot that claims success would be worse than none: restoring it would silently
      // drop whatever failed to copy.
      rmSync(directory, { recursive: true, force: true })
      return { ok: false, error: `cannot copy ${name}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // Also capture the home-level patch layer, which is outside the profile but is part of how this
  // profile starts.
  const homePatch = join(home, 'cordis.patch.yml')
  if (existsSync(homePatch)) {
    try {
      copyFileSync(homePatch, join(directory, 'home-cordis.patch.yml'))
      files.push('home-cordis.patch.yml')
    } catch { /* not fatal: the profile files are what matter */ }
  }

  const meta = {
    schemaVersion: 1,
    id,
    at: now.toISOString(),
    profile,
    reason,
    files,
    digests: Object.fromEntries(files.map((name) => [name, digestOf(join(directory, name))])),
  }
  writeFileSync(join(directory, 'snapshot.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  prune(home)
  return { ok: true, id, files, directory }
}

/** @param {string} path */
function digestOf(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * Snapshot ids, newest first.
 * @param {string} home
 * @returns {Array<{id: string, at: string, profile: string, reason: string, files: string[]}>}
 */
export function listSnapshots(home) {
  const root = snapshotRoot(home)
  if (!existsSync(root)) return []
  const rows = []
  for (const name of readdirSync(root)) {
    const metaPath = join(root, name, 'snapshot.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta?.schemaVersion !== 1 || typeof meta.id !== 'string') continue
      rows.push({
        id: meta.id,
        at: meta.at,
        profile: meta.profile,
        reason: meta.reason ?? 'manual',
        files: Array.isArray(meta.files) ? meta.files : [],
      })
    } catch { /* a half-written snapshot.json is not a snapshot */ }
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** Remove all but the newest KEEP snapshots. */
function prune(home) {
  const all = listSnapshots(home)
  for (const old of all.slice(KEEP)) {
    try { rmSync(join(snapshotRoot(home), old.id), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/**
 * Restore one snapshot over the profile.
 *
 * Preview first by default. Restoring writes over live configuration, and the profile may have changed
 * since the snapshot was taken — the report names what would be overwritten so the call can be
 * deliberate rather than hopeful.
 *
 * @param {string} home
 * @param {string} profile
 * @param {string} id
 * @param {{apply?: boolean, now?: Date}} [options]
 * @returns {{ok: true, plan: object} | {ok: false, error: string}}
 */
export function restoreSnapshot(home, profile, id, { apply = false, now = new Date() } = {}) {
  const root = snapshotRoot(home)
  const directory = join(root, String(id))
  const metaPath = join(directory, 'snapshot.json')
  if (!existsSync(metaPath)) return { ok: false, error: `no snapshot ${id}` }

  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    return { ok: false, error: `snapshot metadata is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (meta?.schemaVersion !== 1) return { ok: false, error: `snapshot schemaVersion ${meta?.schemaVersion} is not 1` }
  // A snapshot from another profile describes different files; restoring it would rewrite the wrong
  // configuration and call it a recovery.
  if (meta.profile !== profile) return { ok: false, error: `snapshot is for profile "${meta.profile}", not "${profile}"` }

  const profileDir = join(home, 'profiles', profile)
  const plan = { id: meta.id, at: meta.at, profile, changes: [] }

  // Each entry carries where it goes and where it comes from. Deriving one from the other by comparing
  // strings is what broke the home-level patch: the comparison was against a bare file name while the
  // recorded path is home-relative, so it never matched.
  const entries = []
  for (const name of meta.files ?? []) {
    const source = join(directory, name)
    if (!existsSync(source)) continue
    const target = name === 'home-cordis.patch.yml' ? join(home, 'cordis.patch.yml') : join(profileDir, name)
    const current = existsSync(target) ? digestOf(target) : null
    const wanted = digestOf(source)
    const change = current === null ? 'create' : current === wanted ? 'unchanged' : 'overwrite'
    entries.push({ name, source, target, change })
    plan.changes.push({ file: relative(home, target), change })
  }

  const changing = entries.filter((entry) => entry.change !== 'unchanged')
  if (changing.length === 0) return { ok: true, plan: { ...plan, applied: false, note: 'already identical' } }
  if (!apply) return { ok: true, plan: { ...plan, applied: false } }

  // Keep what is there before overwriting it. Restoring is the operation most likely to be regretted,
  // and it must itself be undoable.
  const safety = takeSnapshot(home, profile, { reason: `before-restore-${meta.id}`, now })
  if (safety.ok !== true) return { ok: false, error: `refusing to restore without a safety copy: ${safety.error}` }

  const written = []
  for (const entry of entries) {
    if (entry.change === 'unchanged') continue
    try {
      copyFileSync(entry.source, entry.target)
      written.push(relative(home, entry.target))
    } catch (error) {
      // Say what was written before the failure, so the state on disk is not a mystery.
      return {
        ok: false,
        error: `restored ${written.length} file(s), then failed on ${relative(home, entry.target)}: ${error instanceof Error ? error.message : String(error)}`,
        written,
      }
    }
  }

  return { ok: true, plan: { ...plan, applied: true, written, safetySnapshot: safety.id } }
}

/**
 * How much space the snapshots take, so a user can see before they grow.
 * @param {string} home
 */
export function snapshotUsage(home) {
  const root = snapshotRoot(home)
  if (!existsSync(root)) return { count: 0, bytes: 0 }
  let bytes = 0
  let count = 0
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      count += 1
      for (const file of readdirSync(dir)) {
        try { bytes += statSync(join(dir, file)).size } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return { count, bytes }
}
