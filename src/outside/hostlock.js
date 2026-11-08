/**
 * Remember whether the host is already running, so the tool does not start a second copy.
 *
 * Why a file: the host can be started from this tool, from the Start menu, or from its own desktop
 * icon. In the last two cases there is no port to probe, so the only shared thing is the filesystem.
 *
 * Staleness is handled by the pid: a lock whose process is gone is not a lock. That is checked with
 * `process.kill(pid, 0)`, which raises ESRCH for a pid that no longer exists and EPERM for one that
 * exists but belongs to someone else — the second case still means "running".
 * @module outside/hostlock
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the lock lives, inside the profile. */
export function lockPath(home, profile) {
  return join(home, 'profiles', profile, '.plugin-health-host.json')
}

/**
 * Is a pid alive?
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user; still running.
    return error?.code === 'EPERM'
  }
}

/**
 * What the lock says right now.
 *
 * @param {string} home
 * @param {string} profile
 * @returns {{running: false} | {running: true, pid: number, at: string, source: string}}
 */
export function hostStatus(home, profile) {
  const path = lockPath(home, profile)
  if (!existsSync(path)) return { running: false }
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record === null || typeof record !== 'object') return { running: false }
    if (!alive(record.pid)) {
      // The process is gone; the file is a leftover. Cleaning it here keeps the file honest.
      try { rmSync(path, { force: true }) } catch { /* best effort */ }
      return { running: false }
    }
    return {
      running: true,
      pid: record.pid,
      at: typeof record.at === 'string' ? record.at : '',
      source: typeof record.source === 'string' ? record.source : 'unknown',
    }
  } catch {
    // A malformed lock is not evidence that something is running.
    return { running: false }
  }
}

/**
 * Record that this tool started the host.
 *
 * @param {string} home
 * @param {string} profile
 * @param {{pid: number, source?: string, now?: Date}} options
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function recordHost(home, profile, { pid, source = 'outside', now = new Date() }) {
  try {
    writeFileSync(lockPath(home, profile), JSON.stringify({
      schemaVersion: 1,
      pid,
      at: now.toISOString(),
      source,
    }, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    // Failing to write the lock must not stop the host from having started.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Forget the recorded host, for when the user has stopped it and wants to start again.
 * @param {string} home
 * @param {string} profile
 */
export function clearHost(home, profile) {
  try { rmSync(lockPath(home, profile), { force: true }) } catch { /* best effort */ }
}
