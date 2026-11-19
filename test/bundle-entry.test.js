// Entry-point reachability: a bundle whose package.json parses but whose declared code is absent.
//
// Raised in deepseek-ai/deepseek-harness#13379 by ChenYichener: their 0.1.0 shipped with its data left out
// by .gitignore, so it installed, started, and rendered an empty list. Our check stopped one level earlier
// -- "the manifest parses" -- which cannot see this.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectDshHome } from '../src/repair/inspect.js'

/**
 * A profile with one third-party bundle whose files are chosen by the caller.
 *
 * @param {{manifest?: object, files?: Record<string, string>}} [options]
 */
function profileWithBundle({ manifest = {}, files = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-entry-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: ['dsh-under-test'] } },
  }))

  const bundle = join(profile, 'node_modules', 'dsh-under-test')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'dsh-under-test', version: '1.0.0', ...manifest }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(bundle, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return { home }
}

/** Run the scan and return the finding ids. */
const idsOf = (home) => (inspectDshHome({ home, profile: 'web', runtimeVersion: '0.2.2-rc.3' }).findings ?? []).map((f) => f.id)

test('a bundle whose entry file is missing is reported, not silently accepted', () => {
  // The exact shape of a package published with its build output left out: manifest parses, dist/ is absent.
  const { home } = profileWithBundle({ manifest: { main: 'dist/index.js' } })
  const result = inspectDshHome({ home, profile: 'web', runtimeVersion: '0.2.2-rc.3' })
  const finding = (result.findings ?? []).find((f) => f.id === 'bundle-entry-missing')
  assert.ok(finding, `expected bundle-entry-missing, saw: ${idsOf(home).join(', ')}`)
  assert.equal(finding.severity, 'error', 'a plugin that cannot load is an error, not a warning')
  assert.match(finding.title, /dsh-under-test/u)
  assert.match(finding.detail, /dist\/index\.js/u, 'the detail must name the missing path')
  assert.match(finding.detail, /empty shell/u, 'and say what the user will see')
})

test('a bundle whose entry file exists is not reported', () => {
  // The control: without this, the test above would also pass if every bundle were flagged.
  const { home } = profileWithBundle({ manifest: { main: 'dist/index.js' }, files: { 'dist/index.js': 'export const x = 1' } })
  assert.ok(!idsOf(home).includes('bundle-entry-missing'))
})

test('exports map targets are checked too, not just main', () => {
  // Modern packages often omit `main` entirely, so checking only that field would miss most of them.
  const { home } = profileWithBundle({
    manifest: { exports: { '.': { import: './esm/index.mjs', require: './cjs/index.cjs' } } },
  })
  const finding = (inspectDshHome({ home, profile: 'web', runtimeVersion: '0.2.2-rc.3' }).findings ?? [])
    .find((f) => f.id === 'bundle-entry-missing')
  assert.ok(finding, 'a missing exports target is the same fault as a missing main')
  assert.match(finding.detail, /esm\/index\.mjs|index\.mjs/u)
})

test('one present exports target is enough — the tool does not guess the condition', () => {
  // The host picks a condition at load time; as long as a declared target exists, this check has no
  // basis to call the package broken.
  const { home } = profileWithBundle({
    manifest: { exports: { '.': { import: './esm/index.mjs', require: './cjs/index.cjs' } } },
    files: { 'esm/index.mjs': 'export const x = 1' },
  })
  assert.ok(!idsOf(home).includes('bundle-entry-missing'))
})

test('a directory entry is satisfied by its index file, as Node resolves it', () => {
  const { home } = profileWithBundle({ manifest: { main: 'lib' }, files: { 'lib/index.js': 'module.exports = 1' } })
  assert.ok(!idsOf(home).includes('bundle-entry-missing'))
})

test('a directory entry with no index file is reported', () => {
  // The directory exists but is empty -- the "existsSync is not enough" case, one level down.
  const { home } = profileWithBundle({ manifest: { main: 'lib' } })
  assert.ok(idsOf(home).includes('bundle-entry-missing'))
})

test('a bundle that declares no entry at all is not reported', () => {
  // A patch-only bundle (cordis.patch.yml) legitimately has no main. Inventing a failure here would be
  // the same mistake as the proxy warning: reporting a healthy shape as broken.
  const { home } = profileWithBundle({ manifest: {}, files: { 'cordis.patch.yml': '- insert: []' } })
  assert.ok(!idsOf(home).includes('bundle-entry-missing'))
})

test('an unparseable manifest still reports the older finding, and does not add this one', () => {
  // The two findings answer different questions, and a broken manifest has no entries to check.
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-entry-bad-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'dsh-under-test'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-under-test'] } } }))
  writeFileSync(join(profile, 'node_modules', 'dsh-under-test', 'package.json'), '{ not json')

  const ids = idsOf(home)
  assert.ok(ids.includes('bundle-manifest-invalid'), 'the manifest fault is still reported')
  assert.ok(!ids.includes('bundle-entry-missing'), 'no entry finding when the manifest cannot be read')
})