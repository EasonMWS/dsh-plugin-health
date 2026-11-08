import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LOCK_FILE, SCHEMA_VERSION, acquireLock, pluginFingerprint,
  readState, stateDirectory, statePath, updateState, writeAtomically,
} from '../src/state/shared.js'

// Two processes share this file: the panel inside DSH and the tool outside it. Everything here is
// about what happens when both are running — a single-process test passes while the real case
// corrupts the file.

const MODULE_URL = new URL('../src/state/shared.js', import.meta.url).href

function home() {
  return mkdtempSync(join(tmpdir(), 'shared-state-'))
}

test('a fresh home reads as empty state, not as an error', () => {
  const dir = home()
  try {
    const { state, problem } = readState(dir)
    assert.equal(problem, undefined)
    assert.equal(state.rev, 0)
    assert.equal(state.schemaVersion, SCHEMA_VERSION)
    assert.equal(state.admission, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a change bumps the revision and records who wrote it', () => {
  const dir = home()
  try {
    const first = updateState(dir, (current) => ({ ...current, admission: { verdict: 'pass' } }), { writer: 'outside' })
    assert.equal(first.ok, true)
    assert.equal(first.state.rev, 1)
    assert.equal(first.state.writer, 'outside')

    const second = updateState(dir, (current) => ({ ...current, admission: { verdict: 'warn' } }), { writer: 'inside' })
    assert.equal(second.state.rev, 2)
    assert.equal(second.state.writer, 'inside')
    assert.equal(readState(dir).state.admission.verdict, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a change sees what the other writer already put there', () => {
  // The writer must read inside the lock. A write-only path would drop the other side's field.
  const dir = home()
  try {
    updateState(dir, (current) => ({ ...current, admission: { verdict: 'pass' } }), { writer: 'outside' })
    updateState(dir, (current) => ({ ...current, lastSnapshot: { id: 'snap-1' } }), { writer: 'inside' })
    const { state } = readState(dir)
    assert.equal(state.admission.verdict, 'pass', 'the outside writer field survived')
    assert.equal(state.lastSnapshot.id, 'snap-1', 'the inside writer field landed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second writer is refused while the lock is held, and can proceed after release', () => {
  const dir = home()
  try {
    const held = acquireLock(dir)
    assert.equal(held.ok, true)

    const second = acquireLock(dir, { waitMs: 50 })
    assert.equal(second.ok, false)
    assert.match(second.error, /another writer/u)

    held.release()
    const third = acquireLock(dir, { waitMs: 50 })
    assert.equal(third.ok, true)
    third.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock left behind by a crashed writer is aged out', () => {
  const dir = home()
  try {
    mkdirSync(stateDirectory(dir), { recursive: true })
    writeFileSync(join(stateDirectory(dir), LOCK_FILE), JSON.stringify({ pid: 999999, at: 'old' }), 'utf8')

    const early = acquireLock(dir, { waitMs: 30, staleMs: 60_000 })
    assert.equal(early.ok, false, 'a fresh lock must not be stolen')

    const late = acquireLock(dir, { waitMs: 30, staleMs: 0 })
    assert.equal(late.ok, true, 'an abandoned lock must be recoverable')
    late.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed state file is reported, not silently replaced', () => {
  // Overwriting it would destroy whatever the other process was saying, and the caller needs to know
  // the file is bad rather than see a blank one.
  const dir = home()
  try {
    mkdirSync(stateDirectory(dir), { recursive: true })
    writeFileSync(statePath(dir), '{ not json', 'utf8')

    const read = readState(dir)
    assert.equal(read.state.rev, 0, 'the caller gets an empty state to work from')
    assert.match(read.problem, /unreadable/u)

    const written = updateState(dir, (current) => current, { writer: 'inside' })
    assert.equal(written.ok, false)
    assert.match(written.error, /unreadable/u)
    assert.equal(readFileSync(statePath(dir), 'utf8'), '{ not json', 'the bad file is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a newer schema is refused rather than downgraded', () => {
  const dir = home()
  try {
    mkdirSync(stateDirectory(dir), { recursive: true })
    writeFileSync(statePath(dir), JSON.stringify({ schemaVersion: 99, rev: 5 }), 'utf8')

    const read = readState(dir)
    assert.match(read.problem, /schemaVersion 99/u)
    assert.equal(updateState(dir, (c) => c, { writer: 'inside' }).ok, false)
    assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8')).schemaVersion, 99, 'left as it was')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an atomic write replaces the file and leaves no temp behind', () => {
  const dir = home()
  try {
    const path = join(dir, 'x.json')
    writeFileSync(path, '{"old":true}', 'utf8')
    writeAtomically(path, '{"new":true}')
    assert.equal(readFileSync(path, 'utf8'), '{"new":true}')
    const left = readFileSync(path, 'utf8')
    assert.equal(left.includes('old'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two processes writing at the same time do not lose a field', async () => {
  // The cases above are single-process. This is the one that matters: both writers alive at once,
  // each doing a read-modify-write, neither allowed to drop the other's field or lose a revision.
  const dir = home()
  try {
    const worker = join(dir, 'writer.mjs')
    writeFileSync(worker, `
import { updateState } from ${JSON.stringify(MODULE_URL)}
const [home, writer, field, rounds] = process.argv.slice(2)
let refused = 0
for (let i = 0; i < Number(rounds); i += 1) {
  const result = updateState(home, (current) => ({ ...current, [field]: i }), { writer })
  if (!result.ok) refused += 1
}
process.stdout.write(JSON.stringify({ refused }))
`, 'utf8')

    const spawnWriter = (writer, field) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, dir, writer, field, '25'], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer exited ${code}`))))
    })

    // Both at once, not one after the other.
    const [inside, outside] = await Promise.all([
      spawnWriter('inside', 'fromInside'),
      spawnWriter('outside', 'fromOutside'),
    ])

    const { state } = readState(dir)
    assert.equal(inside.refused, 0, 'the inside writer should never be refused')
    assert.equal(outside.refused, 0, 'the outside writer should never be refused')
    assert.equal(state.rev, 50, `expected 50 revisions from two writers of 25, saw ${state.rev}`)
    assert.equal(state.fromInside, 24, 'inside writer last value survived')
    assert.equal(state.fromOutside, 24, 'outside writer last value survived')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin fingerprint ignores order and changes when the set changes', () => {
  const a = pluginFingerprint([{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }])
  const b = pluginFingerprint([{ name: 'b', version: '2.0.0' }, { name: 'a', version: '1.0.0' }])
  assert.equal(a, b, 'order must not matter')

  const c = pluginFingerprint([{ name: 'a', version: '1.0.1' }, { name: 'b', version: '2.0.0' }])
  assert.notEqual(a, c, 'a version change must change the fingerprint')
  assert.equal(a.length, 16)
})
