import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSnapshots, restoreSnapshot, snapshotRoot, snapshotUsage, takeSnapshot } from '../src/outside/snapshot.js'

// A snapshot that cannot be restored is worse than none: it looks like a safety net and is not one.
// Most of these tests are about refusing to restore rather than about copying files.

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'))
  const profileDir = join(dir, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }), 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: a\n', 'utf8')
  return { dir, profileDir }
}

test('a snapshot captures the configuration files and not the packages', () => {
  const { dir, profileDir } = makeHome()
  try {
    writeFileSync(join(profileDir, 'node_modules', 'big.js'), 'x'.repeat(1000), 'utf8')
    const result = takeSnapshot(dir, 'desktop', { reason: 'test' })
    assert.equal(result.ok, true)
    assert.ok(result.files.includes('package.json'))
    assert.ok(result.files.includes('cordis.patch.yml'))
    assert.equal(result.files.includes('big.js'), false, 'node_modules is not part of a snapshot')

    const meta = JSON.parse(readFileSync(join(result.directory, 'snapshot.json'), 'utf8'))
    assert.equal(meta.reason, 'test')
    assert.equal(meta.profile, 'desktop')
    assert.ok(Object.keys(meta.digests).length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoring previews before it writes', () => {
  const { dir, profileDir } = makeHome()
  try {
    const snap = takeSnapshot(dir, 'desktop')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ changed: true }), 'utf8')

    const preview = restoreSnapshot(dir, 'desktop', snap.id)
    assert.equal(preview.ok, true)
    assert.equal(preview.plan.applied, false, 'a preview must not write')
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).changed, true, 'the file is untouched')
    assert.ok(preview.plan.changes.some((row) => row.change === 'overwrite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoring writes the files back', () => {
  const { dir, profileDir } = makeHome()
  try {
    const original = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const snap = takeSnapshot(dir, 'desktop')
    writeFileSync(join(profileDir, 'package.json'), '{"broken":true}', 'utf8')

    const applied = restoreSnapshot(dir, 'desktop', snap.id, { apply: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.plan.applied, true)
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoring takes its own safety copy first', () => {
  // Restoring is the operation most likely to be regretted; it has to be undoable itself.
  const { dir, profileDir } = makeHome()
  try {
    const snap = takeSnapshot(dir, 'desktop')
    writeFileSync(join(profileDir, 'package.json'), '{"current":true}', 'utf8')

    const applied = restoreSnapshot(dir, 'desktop', snap.id, { apply: true })
    assert.equal(applied.ok, true)
    assert.ok(typeof applied.plan.safetySnapshot === 'string' && applied.plan.safetySnapshot !== '')

    // The safety copy holds what was there just before the restore.
    const safetyMeta = JSON.parse(readFileSync(join(snapshotRoot(dir), applied.plan.safetySnapshot, 'snapshot.json'), 'utf8'))
    assert.match(safetyMeta.reason, /^before-restore-/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a snapshot from another profile is refused', () => {
  // Restoring it would rewrite the wrong configuration and call it a recovery.
  const { dir } = makeHome()
  try {
    const snap = takeSnapshot(dir, 'desktop')
    const wrong = restoreSnapshot(dir, 'web', snap.id, { apply: true })
    assert.equal(wrong.ok, false)
    assert.match(wrong.error, /profile "desktop"/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing snapshot is refused', () => {
  const { dir } = makeHome()
  try {
    const missing = restoreSnapshot(dir, 'desktop', 'nope')
    assert.equal(missing.ok, false)
    assert.match(missing.error, /no snapshot/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable snapshot metadata file is refused, not guessed at', () => {
  const { dir } = makeHome()
  try {
    const snap = takeSnapshot(dir, 'desktop')
    writeFileSync(join(snap.directory, 'snapshot.json'), '{ broken', 'utf8')
    const result = restoreSnapshot(dir, 'desktop', snap.id)
    assert.equal(result.ok, false)
    assert.match(result.error, /unreadable/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoring an identical snapshot changes nothing and says so', () => {
  const { dir } = makeHome()
  try {
    const snap = takeSnapshot(dir, 'desktop')
    const result = restoreSnapshot(dir, 'desktop', snap.id, { apply: true })
    assert.equal(result.ok, true)
    assert.equal(result.plan.applied, false)
    assert.match(result.plan.note, /identical/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshots are listed newest first', () => {
  const { dir } = makeHome()
  try {
    takeSnapshot(dir, 'desktop', { now: new Date('2026-01-01T00:00:00Z'), reason: 'old' })
    takeSnapshot(dir, 'desktop', { now: new Date('2026-02-01T00:00:00Z'), reason: 'new' })
    const list = listSnapshots(dir)
    assert.equal(list.length, 2)
    assert.equal(list[0].reason, 'new')
    assert.equal(list[1].reason, 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('old snapshots are pruned so the directory cannot grow without limit', () => {
  const { dir } = makeHome()
  try {
    for (let i = 0; i < 24; i += 1) {
      takeSnapshot(dir, 'desktop', { now: new Date(Date.UTC(2026, 0, 1, 0, i)), reason: `n${i}` })
    }
    const list = listSnapshots(dir)
    assert.ok(list.length <= 20, `expected at most 20 snapshots, saw ${list.length}`)
    assert.ok(list.some((row) => row.reason === 'n23'), 'the newest must survive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the home-level patch layer is captured alongside the profile', () => {
  // It is outside the profile but is part of how this profile starts.
  const { dir } = makeHome()
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: home-level\n', 'utf8')
    const snap = takeSnapshot(dir, 'desktop')
    assert.equal(snap.ok, true)
    assert.ok(snap.files.includes('home-cordis.patch.yml'), JSON.stringify(snap.files))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('usage reports what the snapshots cost', () => {
  const { dir } = makeHome()
  try {
    takeSnapshot(dir, 'desktop')
    const usage = snapshotUsage(dir)
    assert.equal(usage.count, 1)
    assert.ok(usage.bytes > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restores every file it captured, including the home-level patch', () => {
  // CI caught this on Linux. The write-back loop decided whether a file was the home-level patch by
  // comparing `row.file === join('cordis.patch.yml')`, but row.file is home-relative, so the comparison
  // never matched and that file was silently skipped. The source lookup then resolved to the snapshot
  // directory itself for a name it did not recognise, and copyFileSync failed with EISDIR.
  const { dir, profileDir } = makeHome()
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: home-level-original\n', 'utf8')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: profile-original\n', 'utf8')
    const profilePackage = readFileSync(join(profileDir, 'package.json'), 'utf8')

    const snap = takeSnapshot(dir, 'desktop')
    assert.equal(snap.ok, true)
    assert.ok(snap.files.includes('home-cordis.patch.yml'), 'the home patch must be captured')

    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: home-level-changed\n', 'utf8')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: profile-changed\n', 'utf8')
    writeFileSync(join(profileDir, 'package.json'), '{"broken":true}', 'utf8')

    const applied = restoreSnapshot(dir, 'desktop', snap.id, { apply: true })
    assert.equal(applied.ok, true, applied.error)

    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), '- id: home-level-original\n',
      'the home-level patch was not restored')
    assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: profile-original\n',
      'the profile patch was not restored')
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), profilePackage,
      'the profile manifest was not restored')

    assert.equal(applied.plan.changes.filter((row) => row.change === 'overwrite').length, 3,
      'all three changed files should be reported as overwrites')
    assert.equal(applied.plan.written.length, 3, 'and all three should be written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restore reports what it wrote', () => {
  // On failure the caller has to know what already landed rather than guess at the state on disk.
  const { dir, profileDir } = makeHome()
  try {
    const snap = takeSnapshot(dir, 'desktop')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: changed\n', 'utf8')

    const result = restoreSnapshot(dir, 'desktop', snap.id, { apply: true })
    assert.equal(result.ok, true)
    assert.ok(Array.isArray(result.plan.written), 'the plan must say what was written')
    assert.ok(result.plan.written.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two snapshots in the same millisecond cannot overwrite each other', () => {
  // This caused a real, silent data-loss bug. Ids came from the clock, and restoreSnapshot takes a safety
  // copy of the profile before writing anything back — so on a fast machine the safety copy landed in the
  // same millisecond as the snapshot being restored, overwrote it with the broken content the user was
  // trying to undo, and the restore reported success while putting the bad files back.
  //
  // Reproduced by forcing the clock; on CI it happened naturally, which is why Ubuntu failed and Windows
  // did not, and why the failing test differed between Node 20 and Node 22.
  const { dir, profileDir } = makeHome()
  try {
    const instant = new Date('2026-11-08T07:30:00.000Z')

    writeFileSync(join(profileDir, 'package.json'), '{"generation":1}', 'utf8')
    const first = takeSnapshot(dir, 'desktop', { now: instant, reason: 'first' })

    writeFileSync(join(profileDir, 'package.json'), '{"generation":2}', 'utf8')
    const second = takeSnapshot(dir, 'desktop', { now: instant, reason: 'second' })

    assert.notEqual(first.id, second.id, 'two snapshots at the same instant must not share an id')
    assert.equal(listSnapshots(dir).length, 2, 'both snapshots must survive')

    // The one that matters: restoring the first must give the first, not whatever came after it.
    writeFileSync(join(profileDir, 'package.json'), '{"broken":true}', 'utf8')
    const applied = restoreSnapshot(dir, 'desktop', first.id, { apply: true })
    assert.equal(applied.ok, true, applied.error)
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), '{"generation":1}',
      'the restore produced the wrong snapshot content')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restore never overwrites the snapshot it is restoring', () => {
  // The safety copy exists so a restore can be undone. If it can replace the source, the operation is
  // circular: it protects the state it is about to destroy with the state it is about to destroy.
  const { dir, profileDir } = makeHome()
  try {
    writeFileSync(join(profileDir, 'package.json'), '{"good":true}', 'utf8')
    const snap = takeSnapshot(dir, 'desktop')

    writeFileSync(join(profileDir, 'package.json'), '{"broken":true}', 'utf8')
    const applied = restoreSnapshot(dir, 'desktop', snap.id, { apply: true })
    assert.equal(applied.ok, true, applied.error)

    // The source snapshot is unchanged.
    const source = JSON.parse(readFileSync(join(snapshotRoot(dir), snap.id, 'snapshot.json'), 'utf8'))
    assert.equal(source.id, snap.id)
    const content = readFileSync(join(snapshotRoot(dir), snap.id, 'package.json'), 'utf8')
    assert.equal(content, '{"good":true}', 'the snapshot was overwritten by its own safety copy')

    // And there is a separate safety copy holding what the profile looked like before.
    assert.ok(typeof applied.plan.safetySnapshot === 'string')
    assert.notEqual(applied.plan.safetySnapshot, snap.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a profile that does not exist is refused rather than snapshotted empty', () => {
  const { dir } = makeHome()
  try {
    const result = takeSnapshot(dir, 'nope')
    assert.equal(result.ok, false)
    assert.match(result.error, /no profile/u)
    assert.equal(existsSync(join(snapshotRoot(dir), 'nope')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
