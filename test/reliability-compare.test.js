import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildReliabilityReport, compareReliabilityReports, readBoundedText } from '../src/reliability/report.js'

// The reliability module is the part of 3.0 that reads configuration the tool did not write. Its
// comparison and bounds helpers were covered only indirectly — through one end-to-end test — so the
// refusal paths, which are the ones that matter when the input is a file on someone else's machine,
// had no direct assertions.

/** A minimal version-1 snapshot, shaped like what buildReliabilityReport returns. */
function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: 'desktop',
    capturedAt: '2026-11-05T00:00:00Z',
    currentVersion: '0.2.1-rc.5',
    targetVersion: null,
    packages: [],
    patches: [],
    findings: [],
    candidate: null,
    activation: null,
    resourceDeclarations: [],
    limits: [],
    changes: [],
    ...overrides,
  }
}

const pkg = (name, version) => ({ name, version, source: 'node_modules', fingerprint: `${name}@${version}` })
const patch = (layer, fingerprint) => ({ layer, fingerprint })

test('an unchanged snapshot compares to nothing', () => {
  const before = snapshot({ packages: [pkg('a', '1.0.0')], patches: [patch('profile', 'x')] })
  const after = snapshot({ packages: [pkg('a', '1.0.0')], patches: [patch('profile', 'x')] })
  const diff = compareReliabilityReports(before, after)
  assert.deepEqual(diff.packages ?? [], [])
  assert.deepEqual(diff.patches ?? [], [])
})

test('a package that appears, disappears or changes version is reported as such', () => {
  const before = snapshot({ packages: [pkg('kept', '1.0.0'), pkg('gone', '1.0.0'), pkg('bumped', '1.0.0')] })
  const after = snapshot({ packages: [pkg('kept', '1.0.0'), pkg('added', '2.0.0'), pkg('bumped', '1.1.0')] })
  const rows = compareReliabilityReports(before, after).packages ?? []
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
  assert.equal(byName.added?.change, 'added')
  assert.equal(byName.gone?.change, 'removed')
  assert.equal(byName.bumped?.change, 'changed')
  assert.equal(byName.kept, undefined, 'an unchanged package must not appear')
})

test('a patch layer whose fingerprint moved is a change', () => {
  const before = snapshot({ patches: [patch('profile', 'aaa')] })
  const after = snapshot({ patches: [patch('profile', 'bbb')] })
  const rows = compareReliabilityReports(before, after).patches ?? []
  assert.equal(rows.length, 1)
  // Patches are keyed by `layer` but the shared helper reports the key under `name`.
  assert.equal(rows[0].name, 'profile')
  assert.equal(rows[0].change, 'changed')
})

test('comparing two different profile names is refused', () => {
  // A snapshot carries no environment identity, only a profile name. If the names differ the two
  // files describe different things and any difference between them is meaningless.
  assert.throws(
    () => compareReliabilityReports(snapshot({ profile: 'desktop' }), snapshot({ profile: 'web' })),
    /same profile name/u,
  )
})

test('a snapshot carrying a candidate is refused', () => {
  // Candidate previews are not snapshots: they describe an unpacked directory that may not exist on
  // the machine that later compares them, so the two cannot be diffed as if they were the same kind.
  assert.throws(
    () => compareReliabilityReports(snapshot({ candidate: { directory: '/tmp/x' } }), snapshot()),
    /without a candidate/u,
  )
})

test('malformed input is refused rather than producing a misleading diff', () => {
  const bad = [
    [{}, 'no schemaVersion'],
    [snapshot({ schemaVersion: 2 }), 'wrong schemaVersion'],
    [snapshot({ packages: undefined }), 'packages missing'],
    [snapshot({ packages: [{ version: '1.0.0' }] }), 'package row without a name'],
    [snapshot({ patches: [{ layer: 'profile' }] }), 'patch row without a fingerprint'],
    [null, 'null'],
  ]
  for (const [doc, label] of bad) {
    assert.throws(
      () => compareReliabilityReports(doc, snapshot()),
      /version 1 profile snapshot/u,
      `expected a refusal for: ${label}`,
    )
  }
})

test('readBoundedText refuses a file larger than the limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-'))
  try {
    const small = join(dir, 'small.txt')
    writeFileSync(small, 'hello')
    assert.equal(readBoundedText(small, 1024), 'hello')

    const big = join(dir, 'big.txt')
    writeFileSync(big, 'x'.repeat(2048))
    assert.throws(() => readBoundedText(big, 1024), /too large|limit/iu)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a report on an empty profile says so instead of inventing findings', () => {
  const home = mkdtempSync(join(tmpdir(), 'reliability-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: [] } },
      dependencies: {},
    }))
    const report = buildReliabilityReport({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.5' })
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.profile, 'desktop')
    assert.deepEqual(report.packages, [])
    // The limits list is the tool's own statement about what it did not read. An empty profile still
    // has to carry it, otherwise a reader cannot tell "nothing found" from "nothing looked at".
    assert.ok(Array.isArray(report.limits) && report.limits.length > 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('activation is null when there is no evidence, not an empty success', () => {
  // A quiet profile and a profile nobody sampled look identical in a diff. The report has to
  // distinguish them, because "no evidence" is not "all good".
  const home = mkdtempSync(join(tmpdir(), 'reliability-null-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop', dsh: { profile: { bundles: [] } }, dependencies: {},
    }))
    const report = buildReliabilityReport({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.5' })
    assert.equal(report.activation, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
