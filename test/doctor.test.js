import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { inspectDshHome } from '../src/repair/inspect.js'
import { applyRepairs, planRepairs, removeEmptyPatchEntries } from '../src/repair/apply.js'

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-home-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'dsh-broken'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-missing-dep': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-missing', 'dsh-broken'] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '# keep this comment',
    '- insert:',
    '    - id: example',
    '      name: example',
    '- []',
    '',
  ].join('\n'))
  return { home, profile, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('removeEmptyPatchEntries keeps comments and drops only empty top-level entries', () => {
  const original = '# comment\n- insert:\n    - id: a\n      name: a\n- []\n'
  const edited = removeEmptyPatchEntries(original)
  assert.match(edited, /# comment/u)
  assert.doesNotMatch(edited, /^- \[\]$/mu)
  assert.deepEqual(parseYaml(edited), [{ insert: [{ id: 'a', name: 'a' }] }])
})

test('inspectDshHome finds the Windows/WSL install failure patterns', () => {
  const fixture = fixtureHome()
  try {
    const result = inspectDshHome({ home: fixture.home, profile: 'web' })
    assert.equal(result.profile, 'web')
    const ids = result.findings.map((finding) => finding.id)
    assert.ok(ids.includes('bundle-missing'))
    assert.ok(ids.includes('package-dir-broken'))
    assert.ok(ids.includes('patch-empty-entry'))
    assert.ok(ids.includes('dependency-missing'))
    assert.ok(result.summary.error >= 1)
    assert.ok(result.summary.autoFixable >= 2)
    assert.equal(planRepairs(result.findings).auto.length, result.summary.autoFixable)
  } finally {
    fixture.cleanup()
  }
})

test('inspectDshHome reports runtime incompatibilities when a runtime is supplied', () => {
  const fixture = fixtureHome()
  try {
    const bundle = join(fixture.profile, 'node_modules', 'dsh-missing')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: 'dsh-missing', version: '1.0.0', engines: { dsh: '>=0.3.0' },
    }))
    const result = inspectDshHome({ home: fixture.home, profile: 'web', runtimeVersion: '0.2.1-rc.2' })
    assert.ok(result.findings.some((finding) => finding.id === 'plugin-incompatible'))
  } finally {
    fixture.cleanup()
  }
})

test('applyRepairs is a no-op in dry-run mode', async () => {
  const fixture = fixtureHome()
  try {
    const result = inspectDshHome({ home: fixture.home, profile: 'web' })
    const applied = await applyRepairs(result.findings, { home: fixture.home, dryRun: true })
    assert.ok(applied.actions.length > 0)
    assert.ok(existsSync(join(fixture.profile, 'node_modules', 'dsh-broken')))
    assert.match(readFileSync(join(fixture.profile, 'cordis.patch.yml'), 'utf8'), /^- \[\]$/mu)
    assert.equal(existsSync(join(fixture.home, '.plugin-health')), false)
  } finally {
    fixture.cleanup()
  }
})

test('applyRepairs quarantines broken directories and rewrites the patch', async () => {
  const fixture = fixtureHome()
  try {
    const result = inspectDshHome({ home: fixture.home, profile: 'web' })
    const applied = await applyRepairs(result.findings, { home: fixture.home, dryRun: false })
    assert.ok(applied.actions.length >= 2)
    assert.equal(existsSync(join(fixture.profile, 'node_modules', 'dsh-broken')), false)
    assert.ok(existsSync(join(applied.quarantineDir, 'profiles', 'web', 'node_modules', 'dsh-broken')))
    assert.doesNotMatch(readFileSync(join(fixture.profile, 'cordis.patch.yml'), 'utf8'), /^- \[\]$/mu)
    assert.ok(existsSync(join(applied.quarantineDir, 'repair-log.json')))
    const log = JSON.parse(readFileSync(join(applied.quarantineDir, 'repair-log.json'), 'utf8'))
    assert.ok(Array.isArray(log.actions))
  } finally {
    fixture.cleanup()
  }
})
