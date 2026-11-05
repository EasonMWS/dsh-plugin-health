import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReliabilityReport } from '../src/reliability/report.js'
import { createLiveObserver } from '../src/reliability/live.js'
import { statusForRequest } from '../src/ui/status.js'

const bin = fileURLToPath(new URL('../bin/dsh-plugin-health.js', import.meta.url))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))

test('a fresh live observation detects failure and recovery despite the cached disk scan', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-live-review-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeJson(join(profile, 'package.json'), {})
  const location = { home, profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }
  let state = 2
  let available = true
  const ctx = { get: () => available ? { *entries() {
    yield { id: 'root/test', options: { id: 'test', name: 'dsh-test' }, fiber: {
      state, _error: new Error('tool "archive" is already registered (secret-fixture-value)'),
    } }
  } } : undefined }
  const observe = createLiveObserver()
  const sample = now => statusForRequest({ url: '/status' }, { ...location, liveReview: observe(ctx, location, now) })
  const before = sample(1000)
  state = 3
  const failed = sample(2000)
  assert.equal(failed.generatedAt, before.generatedAt)
  assert.equal(failed.review.activation[0].state, 'failed')
  assert.deepEqual(failed.liveReview.entries[0].diagnostic, { kind: 'duplicate-tool', tool: 'archive' })
  assert.equal(failed.liveReview.changes[0].before, 'active')
  assert.equal(failed.liveReview.changes[0].id, 'root/test')
  assert.doesNotMatch(JSON.stringify(failed.liveReview), /secret-fixture-value/u)
  writeJson(join(profile, 'package.json'), { name: 'updated-profile' })
  const fresh = statusForRequest({ url: '/status?fresh=1' }, { ...location, liveReview: failed.liveReview })
  assert.notEqual(fresh.review.patches[0].fingerprint, before.review.patches[0].fingerprint)
  state = 2
  assert.equal(sample(3000).liveReview.changes[0].after, 'active')
  available = false
  assert.equal(sample(4000).liveReview, null)
  available = true
  assert.deepEqual(sample(5000).liveReview.changes, [])
})

test('review previews a bundle, preserves the profile and compares saved evidence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const profile = join(home, 'profiles', 'desktop')
  const installed = join(profile, 'node_modules', 'dsh-a')
  const core = join(profile, 'node_modules', '@deepseek-ai', 'dsh-tools')
  const candidate = join(directory, 'candidate')
  for (const path of [installed, core, candidate]) mkdirSync(path, { recursive: true })
  const patch = join(home, 'cordis.patch.yml')
  const bundle = {
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    engines: { dsh: '>=0.2.0 <0.3.0-0' },
    dshPluginHealth: { version: 1, resources: [{ scope: 'workspace', path: 'archive/index.json', access: 'write' }] },
  }
  writeJson(join(profile, 'package.json'), { dsh: { profile: { bundles: ['dsh-a'] } } })
  writeJson(join(installed, 'package.json'), { name: 'dsh-a', version: '1.0.0', ...bundle })
  writeFileSync(join(installed, 'cordis.patch.yml'), '- insert:\n  - id: shared\n    name: dsh-a\n    config:\n      keep: 1\n      removed: secret-fixture-value\n')
  writeJson(join(core, 'package.json'), { name: '@deepseek-ai/dsh-tools', version: '0.2.0' })
  writeJson(join(candidate, 'package.json'), { name: 'dsh-b', version: '1.0.0', ...bundle })
  writeFileSync(join(candidate, 'cordis.patch.yml'), '- id: shared\n  config:\n    keep: 2\n')
  writeFileSync(patch, '# home configuration\n')
  const run = (...args) => spawnSync(process.execPath, [bin, 'review', '--home', home, '--profile', 'desktop',
    '--runtime', '0.2.1', '--json', ...args], { encoding: 'utf8', timeout: 8000 })

  const checked = run('--target', '0.2.2', '--candidate', candidate)
  assert.equal(checked.status, 0, checked.stderr)
  const preview = JSON.parse(checked.stdout)
  assert.equal(preview.candidate.declaration.state, 'compatible')
  assert.equal(preview.activation, null)
  assert.deepEqual(preview.findings.find(row => row.kind === 'config-override'), {
    kind: 'config-override', id: 'shared', previousLayer: 'bundle dsh-a #1', layer: 'candidate dsh-b #1',
    removedKeys: ['removed'], moduleChanged: false,
  })
  assert.ok(preview.findings.some(row => row.kind === 'profile-host-package' && row.name === '@deepseek-ai/dsh-tools'))
  assert.deepEqual(preview.findings.find(row => row.kind === 'declared-shared-write')?.packages, ['dsh-a', 'dsh-b'])
  assert.doesNotMatch(checked.stdout, /secret-fixture-value/u)
  assert.equal(readFileSync(patch, 'utf8'), '# home configuration\n')
  assert.equal(run('--target', '0.3.0').status, 1)
  const snapshot = join(directory, 'before.json')
  assert.equal(run('--save', snapshot).status, 0)
  const originalSnapshot = readFileSync(snapshot, 'utf8')
  assert.equal(run('--save', snapshot).status, 1)
  assert.equal(readFileSync(snapshot, 'utf8'), originalSnapshot)

  writeJson(join(installed, 'package.json'), { name: 'dsh-a', version: '1.1.0', ...bundle })
  writeFileSync(patch, '# changed later\n')
  const compared = run('--compare', snapshot)
  assert.equal(compared.status, 0, compared.stderr)
  const { changes } = JSON.parse(compared.stdout)
  assert.deepEqual(changes.packages, [{ name: 'dsh-a', change: 'changed', before: '1.0.0', after: '1.1.0' }])
  assert.equal(changes.patches[0].name, 'home patch')
  assert.throws(() => buildReliabilityReport({ home, profile: '../desktop' }), /profile not found/u)
  writeJson(join(candidate, 'package.json'), { name: 'dsh-b', version: '1.0.0', dsh: { bundle: { patch: '../outside.yml' } } })
  writeFileSync(join(directory, 'outside.yml'), '- id: shared\n  config: {}\n')
  const partial = buildReliabilityReport({ home, candidateDirectory: candidate })
  assert.ok(partial.limits.includes('unreadable-patch:candidate dsh-b #1'))
  assert.equal(partial.findings.some(row => row.kind === 'config-override'), false)
})
