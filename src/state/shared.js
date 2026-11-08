/**
 * The single shared state file, and the rules for two processes writing it.
 *
 * The panel inside DSH and the tool outside it are two different processes looking at the same
 * profile. They must not each keep their own idea of what is true, and they must not both write
 * configuration — that is how two safety models end up disagreeing.
 *
 * So: one file, one writer at a time, a monotonic revision, and an intent queue for requests that
 * cross the boundary.
 *
 * Measured before designing this:
 *   - fs.watch fires within ~1ms on Windows, including for the atomic rename this writer uses
 *   - the host's HTTP server can hold a connection open, so the panel can be told rather than poll
 * @module state/shared
 */

import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** Where the shared file lives, inside the tool's own directory in the DSH home. */
export const STATE_DIR = '.plugin-health'
export const STATE_FILE = 'state.json'
export const LOCK_FILE = 'state.lock'

export const SCHEMA_VERSION = 1

/** A lock older than this is treated as abandoned by a crashed writer. */
const LOCK_STALE_MS = 30_000

/**
 * Give up waiting rather than hanging a request forever.
 *
 * The lock is held for the length of one read-modify-write, which is microseconds — but on a contended or
 * scanned filesystem it can be much longer. Five seconds was short enough that a CI run refused one write
 * out of fifty; ten leaves room without making a genuinely stuck lock hang a request noticeably.
 */
const LOCK_WAIT_MS = 10_000

/** Pause between attempts. Without this the wait loop burns its deadline in CPU time. */
const LOCK_POLL_MS = 5

/**
 * Block the current thread for a few milliseconds.
 *
 * acquireLock is synchronous, so it cannot await a timer. Atomics.wait on a private buffer is the
 * standard way to yield without spinning.
 * @param {number} ms
 */
function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

/** @returns {string} */
export function stateDirectory(home) {
  return join(home, STATE_DIR)
}

/** @returns {string} */
export function statePath(home) {
  return join(stateDirectory(home), STATE_FILE)
}

/**
 * The empty state a fresh install starts from.
 * @returns {object}
 */
export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    rev: 0,
    writer: null,
    at: null,
    admission: null,
    pendingIntent: null,
    lastSnapshot: null,
  }
}

/**
 * Read the shared state, or the empty state when there is none.
 *
 * A malformed file is not repaired here. Rewriting it would destroy whatever the other process was
 * in the middle of saying, and the caller needs to know the file is bad rather than see it silently
 * replaced with a blank one.
 *
 * @param {string} home
 * @returns {{state: object, problem?: string}}
 */
export function readState(home) {
  const path = statePath(home)
  if (!existsSync(path)) return { state: emptyState() }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: emptyState(), problem: 'state file is not an object' }
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      // Newer file than this build understands. Do not overwrite it.
      return { state: emptyState(), problem: `state schemaVersion ${parsed.schemaVersion} is not ${SCHEMA_VERSION}` }
    }
    return {
      state: {
        ...emptyState(),
        ...parsed,
        rev: typeof parsed.rev === 'number' && Number.isFinite(parsed.rev) ? parsed.rev : 0,
      },
    }
  } catch (error) {
    return { state: emptyState(), problem: `state file is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Take the write lock, or report that someone else holds it.
 *
 * A file lock rather than anything cleverer: both processes are ordinary Node, the file survives
 * either one crashing, and a stale lock can be aged out. The lock records the pid and a timestamp so
 * a later reader can tell "held" from "abandoned".
 *
 * @param {string} home
 * @param {{waitMs?: number, staleMs?: number, now?: () => number}} [options]
 * @returns {{ok: true, release: () => void} | {ok: false, error: string}}
 */
export function acquireLock(home, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, now = Date.now } = {}) {
  const dir = stateDirectory(home)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, LOCK_FILE)
  const deadline = now() + waitMs

  for (;;) {
    try {
      // wx: fail if it exists. That is the whole mutual-exclusion primitive.
      const fd = openSync(path, 'wx')
      const mine = JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() })
      writeSync(fd, mine)
      closeSync(fd)
      let released = false
      return {
        ok: true,
        /**
         * Remove the lock.
         *
         * Ownership is checked so a lock taken over after this one went stale is not deleted by its
         * previous holder. But the check can itself fail — Windows antivirus and the search indexer
         * briefly hold handles, and readFileSync throws EBUSY or EPERM while they do. Treating that as
         * "already gone" leaves the lock behind and blocks every other writer, which is far worse than
         * the narrow risk of deleting a lock that was just taken.
         */
        release() {
          if (released) return
          released = true
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              if (readFileSync(path, 'utf8') === mine) unlinkSync(path)
              return
            } catch (error) {
              // ENOENT means it is already gone; anything else may be a transient handle.
              if (error?.code === 'ENOENT') return
            }
            sleepSync(2)
          }
          // Still stuck. Remove it rather than leave a lock nobody can take.
          releaseLockUnchecked(path)
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, error: `cannot create lock: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    // Held. Is it abandoned?
    try {
      const age = now() - statSync(path).mtimeMs
      if (age > staleMs) {
        try { unlinkSync(path) } catch { /* someone else cleared it first */ }
        continue
      }
    } catch { /* the holder released between our open and stat; retry immediately */ continue }

    if (now() >= deadline) return { ok: false, error: 'another writer holds the state lock' }
    // Yield rather than spin: the other writer needs wall-clock time to finish its read-modify-write.
    sleepSync(Math.min(LOCK_POLL_MS, Math.max(1, deadline - now())))
  }
}

/**
 * Remove a lock file, retrying a few times.
 *
 * Windows refuses to delete a file another process holds a handle on, so a single attempt is not enough.
 * @param {string} path
 */
function releaseLockUnchecked(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      unlinkSync(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
    }
    sleepSync(2)
  }
  return false
}

/**
 * Merge a change into the shared state under the lock.
 *
 * The writer reads, applies its change to the current contents, bumps `rev`, and replaces the file
 * atomically. Reading inside the lock is what makes two writers safe: a plain write-only path would
 * drop whatever the other process added between our read and our write.
 *
 * @param {string} home
 * @param {(current: object) => object} change
 * @param {{writer: 'inside'|'outside', now?: () => number}} options
 * @returns {{ok: true, state: object} | {ok: false, error: string}}
 */
export function updateState(home, change, { writer, now = Date.now } = {}) {
  const lock = acquireLock(home, { now })
  if (lock.ok !== true) return { ok: false, error: lock.error }
  try {
    const { state, problem } = readState(home)
    if (problem !== undefined) return { ok: false, error: problem }

    const next = change({ ...state })
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return { ok: false, error: 'the change did not return a state object' }
    }

    const written = {
      ...next,
      schemaVersion: SCHEMA_VERSION,
      rev: state.rev + 1,
      writer,
      at: new Date(now()).toISOString(),
    }
    writeAtomically(statePath(home), `${JSON.stringify(written, null, 2)}\n`)
    return { ok: true, state: written }
  } finally {
    lock.release()
  }
}

/**
 * Replace a file without ever leaving it half-written.
 *
 * A reader in the other process may load this file at any moment; a partial read would look like a
 * corrupt state and could be "repaired" by overwriting good data.
 * @param {string} path
 * @param {string} contents
 */
export function writeAtomically(path, contents) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, contents, 'utf8')
  try {
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * A fingerprint of what is installed, so a check made outside DSH can be recognised as still valid
 * once DSH starts.
 *
 * Sorted so that two scans of the same set agree regardless of order, and truncated to keep the file
 * readable — this is an identity, not a security boundary.
 * @param {Array<{name?: string, version?: string}>} packages
 * @returns {string}
 */
export function pluginFingerprint(packages) {
  const rows = (packages ?? [])
    .map((row) => `${row?.name ?? ''}@${row?.version ?? ''}`)
    .filter((row) => row !== '@')
    .sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)
}
