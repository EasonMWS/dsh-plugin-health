import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearHost, hostStatus, lockPath, recordHost } from '../src/outside/hostlock.js'

// The point of this file is to stop the tool starting a second copy of the host. The cases that matter
// are the ones where the record is wrong: a pid that has exited, a file someone truncated, a lock left
// behind by a crash.

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'hostlock-'))
  mkdirSync(join(dir, 'profiles', 'desktop'), { recursive: true })
  return dir
}

test('a profile with no record reports nothing running', () => {
  const dir = home()
  try {
    assert.deepEqual(hostStatus(dir, 'desktop'), { running: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record with this process in it reports running', () => {
  const dir = home()
  try {
    assert.equal(recordHost(dir, 'desktop', { pid: process.pid, source: 'test' }).ok, true)
    const status = hostStatus(dir, 'desktop')
    assert.equal(status.running, true)
    assert.equal(status.pid, process.pid)
    assert.equal(status.source, 'test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record whose process has exited does not report running, and is cleaned up', () => {
  // A host that was killed rather than quit leaves this behind. Believing it would make the tool refuse
  // to start DSH ever again.
  const dir = home()
  try {
    // A pid that cannot be running: one below the valid range for a user process on every platform.
    writeFileSync(lockPath(dir, 'desktop'), JSON.stringify({ schemaVersion: 1, pid: 999_999, at: 'x', source: 'outside' }), 'utf8')
    assert.equal(hostStatus(dir, 'desktop').running, false)
    assert.equal(existsSync(lockPath(dir, 'desktop')), false, 'the stale record should be removed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a truncated record is not evidence that something is running', () => {
  const dir = home()
  try {
    writeFileSync(lockPath(dir, 'desktop'), '{ not json', 'utf8')
    assert.equal(hostStatus(dir, 'desktop').running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record with no pid is not evidence either', () => {
  const dir = home()
  try {
    writeFileSync(lockPath(dir, 'desktop'), JSON.stringify({ schemaVersion: 1, at: 'x' }), 'utf8')
    assert.equal(hostStatus(dir, 'desktop').running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearing the record lets the next start proceed', () => {
  const dir = home()
  try {
    recordHost(dir, 'desktop', { pid: process.pid })
    assert.equal(hostStatus(dir, 'desktop').running, true)
    clearHost(dir, 'desktop')
    assert.equal(hostStatus(dir, 'desktop').running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recording into a profile directory that does not exist fails without throwing', () => {
  // The caller must still be able to start the host; the lock is a convenience, not a gate.
  const dir = mkdtempSync(join(tmpdir(), 'hostlock-missing-'))
  try {
    const result = recordHost(dir, 'nope', { pid: process.pid })
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the record is per profile, not per home', () => {
  const dir = home()
  try {
    mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
    recordHost(dir, 'desktop', { pid: process.pid, source: 'desktop-run' })
    assert.equal(hostStatus(dir, 'desktop').running, true)
    assert.equal(hostStatus(dir, 'web').running, false, 'a different profile is a different host')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the record carries a timestamp so the message can be specific', () => {
  const dir = home()
  try {
    const at = new Date('2026-11-08T12:00:00Z')
    recordHost(dir, 'desktop', { pid: process.pid, now: at })
    const status = hostStatus(dir, 'desktop')
    assert.equal(status.at, at.toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
