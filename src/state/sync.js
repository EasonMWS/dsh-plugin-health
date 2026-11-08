/**
 * Watch the shared state and tell whoever is listening that it changed.
 *
 * Two processes share one file. Polling it would work but makes "in sync" mean "within 30 seconds",
 * and a user who disables a plugin in one window and looks at the other should not have to wonder.
 * Measured before building this: fs.watch fires within ~1ms on Windows and captures the atomic
 * rename the writer uses, so the file itself is a reliable change signal.
 *
 * What this module does NOT do is read the state for you. It reports that the file moved; the caller
 * reads it, because between the notification and the read there may have been another change.
 * @module state/sync
 */

import { watch } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { STATE_FILE, STATE_DIR, readState, stateDirectory } from './shared.js'

/**
 * Coalesce bursts of events into one notification.
 *
 * A single atomic write produces two or three watcher events (create, change, rename), and Node also
 * fires for unrelated activity in the directory. Anything reacting to a revision change wants one
 * call per actual change, not one per event.
 */
const QUIET_MS = 40

/**
 * Watch the state file.
 *
 * The directory is watched rather than the file: an atomic replace unlinks the old inode, and a watch
 * on the file itself stops firing after the first replacement on some platforms. Watching the
 * directory and filtering by name survives that.
 *
 * @param {string} home
 * @param {{onChange: (info: {rev: number, writer: string|null, at: string|null}) => void, onError?: (error: Error) => void}} handlers
 * @returns {{close: () => void}}
 */
export function watchState(home, { onChange, onError }) {
  const dir = stateDirectory(home)
  mkdirSync(dir, { recursive: true })

  let timer
  let closed = false
  let lastSeen = readState(home).state.rev

  const flush = () => {
    timer = undefined
    if (closed) return
    const { state, problem } = readState(home)
    if (problem !== undefined) {
      // The other writer may be mid-replacement, or the file is genuinely bad. Either way this is not
      // a change to report; the next event will try again.
      return
    }
    if (state.rev === lastSeen) return
    lastSeen = state.rev
    onChange({ rev: state.rev, writer: state.writer ?? null, at: state.at ?? null })
  }

  let watcher
  try {
    watcher = watch(dir, (_event, name) => {
      if (closed) return
      // `name` is null on some platforms for any change in the directory.
      if (name !== null && name !== STATE_FILE) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(flush, QUIET_MS)
      if (typeof timer?.unref === 'function') timer.unref()
    })
    watcher.on('error', (error) => {
      if (closed) return
      onError?.(error instanceof Error ? error : new Error(String(error)))
    })
  } catch (error) {
    // Watching can fail on network shares and some container filesystems. Report it so the caller can
    // fall back to polling rather than silently never updating.
    onError?.(error instanceof Error ? error : new Error(String(error)))
    return { close() {} }
  }

  return {
    close() {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      try { watcher.close() } catch { /* already closed */ }
    },
  }
}

/**
 * Watch for state changes, falling back to polling when the filesystem will not cooperate.
 *
 * A tool that silently stops noticing changes is worse than one that checks on a timer: the user sees
 * a stale window and has no way to know why.
 *
 * @param {string} home
 * @param {{onChange: Function, onError?: Function, pollMs?: number}} options
 * @returns {{close: () => void, mode: 'watch'|'poll'}}
 */
export function watchStateWithFallback(home, { onChange, onError, pollMs = 2_000 }) {
  let watching = true
  let pollTimer
  let lastRev = readState(home).state.rev

  const deliver = (info) => {
    onChange(info)
  }

  const watcher = watchState(home, {
    onChange: deliver,
    onError: (error) => {
      // Switch to polling for the rest of this session rather than reporting and going quiet.
      watching = false
      onError?.(error)
    },
  })

  const poll = () => {
    if (watching) return
    const { state, problem } = readState(home)
    if (problem === undefined && state.rev !== lastRev) {
      lastRev = state.rev
      deliver({ rev: state.rev, writer: state.writer ?? null, at: state.at ?? null })
    }
  }

  if (pollMs > 0) {
    pollTimer = setInterval(poll, pollMs)
    if (typeof pollTimer?.unref === 'function') pollTimer.unref()
  }

  return {
    get mode() { return watching ? 'watch' : 'poll' },
    close() {
      watcher.close()
      if (pollTimer !== undefined) clearInterval(pollTimer)
    },
  }
}

void existsSync
void join
void STATE_DIR
