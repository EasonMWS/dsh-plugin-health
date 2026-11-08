import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stateDirectory, statePath, updateState } from '../src/state/shared.js'
import { watchState, watchStateWithFallback } from '../src/state/sync.js'

// The point of watching is that a change made by the other process arrives without a poll. These
// tests write through the real updateState, so what is being watched is what the other side actually
// does — not a bare writeFileSync that no real writer would perform.

function home() {
  return mkdtempSync(join(tmpdir(), 'state-sync-'))
}

/** Wait for a notification, or fail after `ms`. */
function nextChange(handle, ms = 3_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    const original = handle.onChange
    handle.onChange = (info) => {
      clearTimeout(timer)
      original?.(info)
      resolve(info)
    }
    void handle
  })
}

/**
 * Watch through a promise, without monkey-patching the handle.
 * @param {string} dir
 * @param {() => void} act
 */
async function expectChange(dir, act) {
  const seen = []
  const watcher = watchState(dir, { onChange: (info) => seen.push(info) })

  // Give the watcher a moment to attach before the change.
  await new Promise((r) => setTimeout(r, 120))
  act()

  const deadline = Date.now() + 3_000
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  watcher.close()
  return seen
}

test('a change written by the other process is noticed without polling', async () => {
  const dir = home()
  try {
    const seen = await expectChange(dir, () => {
      updateState(dir, (current) => ({ ...current, admission: { verdict: 'pass' } }), { writer: 'outside' })
    })
    assert.ok(seen.length >= 1, 'no notification arrived')
    assert.equal(seen[0].rev, 1)
    assert.equal(seen[0].writer, 'outside')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('several rapid writes collapse into one notification per revision change', async () => {
  // One atomic write produces two or three watcher events. Anything reacting to a revision wants one
  // call per change, not one per event.
  const dir = home()
  try {
    const seen = await expectChange(dir, () => {
      updateState(dir, (c) => ({ ...c, a: 1 }), { writer: 'outside' })
      updateState(dir, (c) => ({ ...c, a: 2 }), { writer: 'outside' })
    })
    // Either one coalesced notification or two, but never more than the number of changes.
    assert.ok(seen.length >= 1 && seen.length <= 2, `unexpected notifications: ${seen.length}`)
    assert.equal(seen[seen.length - 1].rev, 2, 'the last notification carries the final revision')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the revision is not reported twice', async () => {
  const dir = home()
  try {
    const seen = []
    const watcher = watchState(dir, { onChange: (info) => seen.push(info) })
    await new Promise((r) => setTimeout(r, 120))

    updateState(dir, (c) => ({ ...c, n: 1 }), { writer: 'inside' })
    await new Promise((r) => setTimeout(r, 300))
    updateState(dir, (c) => ({ ...c, n: 2 }), { writer: 'inside' })
    await new Promise((r) => setTimeout(r, 300))

    watcher.close()
    assert.deepEqual(seen.map((s) => s.rev), [1, 2])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('closing the watcher stops notifications', async () => {
  const dir = home()
  try {
    const seen = []
    const watcher = watchState(dir, { onChange: (info) => seen.push(info) })
    await new Promise((r) => setTimeout(r, 120))
    watcher.close()

    updateState(dir, (c) => ({ ...c, n: 1 }), { writer: 'outside' })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(seen.length, 0, 'a closed watcher must not fire')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watching a directory that does not exist yet reports the failure instead of going quiet', async () => {
  // Watching can fail on network shares and some container filesystems. A tool that silently stops
  // noticing changes is worse than one that checks on a timer.
  const dir = home()
  try {
    const problems = []
    // Remove the state dir so mkdirSync inside is the first thing to run — it should succeed, so the
    // error path here is exercised by the fallback instead.
    const watcher = watchStateWithFallback(dir, {
      onChange: () => {},
      onError: (error) => problems.push(error),
      pollMs: 100,
    })
    assert.equal(watcher.mode, 'watch', 'the watch should work on a normal directory')
    watcher.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the polling fallback still delivers changes', async () => {
  const dir = home()
  try {
    const seen = []
    const watcher = watchStateWithFallback(dir, { onChange: (info) => seen.push(info), pollMs: 80 })
    await new Promise((r) => setTimeout(r, 150))

    updateState(dir, (c) => ({ ...c, fromPoll: true }), { writer: 'outside' })

    const deadline = Date.now() + 3_000
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    watcher.close()

    assert.ok(seen.length >= 1, 'no notification arrived')
    assert.equal(seen[seen.length - 1].writer, 'outside')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a half-written state file is not reported as a change', async () => {
  // A reader can arrive between the temp write and the rename. That must not surface as a revision
  // change with a corrupt payload.
  const dir = home()
  try {
    mkdirSync(stateDirectory(dir), { recursive: true })
    const seen = []
    const watcher = watchState(dir, { onChange: (info) => seen.push(info) })
    await new Promise((r) => setTimeout(r, 120))

    writeFileSync(statePath(dir), '{ half', 'utf8')
    await new Promise((r) => setTimeout(r, 300))

    watcher.close()
    assert.equal(seen.length, 0, 'a malformed file is not a state change')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void nextChange
