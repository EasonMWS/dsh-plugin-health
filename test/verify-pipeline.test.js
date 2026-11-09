import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detect, merge, plan, sanitizeResult } from '../scripts/verify-pipeline.mjs'

const HOST = '0.2.2-rc.1'
const packument = {
  'dist-tags': { latest: HOST, next: HOST, alpha: '0.2.2-alpha.3' },
  versions: { '0.2.1-rc.5': {}, '0.2.2-alpha.3': {}, [HOST]: {} },
}

test('detect: a new host set is a change; the same set is not, unless forced', () => {
  const first = detect(packument, null)
  assert.equal(first.changed, true)
  assert.equal(first.latest, HOST)
  assert.ok(first.hosts.includes(HOST))
  assert.equal(detect(packument, { hosts: first.hosts }).changed, false)
  assert.equal(detect(packument, { hosts: first.hosts }, { force: true }).changed, true)
})

test('plan: the most-downloaded accepted plugins, then a quarter as many rejected', () => {
  const row = (name, compatible) => ({ name, version: '1.0.0', results: { [HOST]: { compatible } } })
  const matrix = { plugins: [row('a', true), row('b', true), row('c', true), row('x', false), row('y', false), row('z', null)] }
  const catalog = { plugins: [{ npm: 'a', downloads: 10 }, { npm: 'b', downloads: 500 }, { npm: 'c', downloads: 50 }, { npm: 'x', downloads: 1 }, { npm: 'y', downloads: 99 }] }
  assert.deepEqual(plan(matrix, catalog, HOST, 2), ['b@1.0.0', 'c@1.0.0', 'y@1.0.0'])
})

function shard(directory, host, rows, results = {}) {
  mkdirSync(join(directory, 'results'), { recursive: true })
  writeFileSync(join(directory, 'verify.json'), JSON.stringify({ host: { version: host }, tool: { version: '3.1.0' }, plugins: rows }))
  for (const [file, body] of Object.entries(results)) writeFileSync(join(directory, file), typeof body === 'string' ? body : JSON.stringify(body))
  return directory
}

test('merge: validates rows, truncates logs, drops bad paths and a shard for another host', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-health-merge-'))
  const huge = 'x'.repeat(40_000)
  const one = shard(join(root, 's1'), HOST, [
    { name: 'a', version: '1.0.0', level: 'V3', result: 'results/a.json' },
    { name: 'b', version: '1.0.0', level: 'V9', failure: { kind: 'missing-service<script>' }, result: '../../escape.json' },
    { name: 42 },
  ], {
    'results/a.json': { ok: true, stages: [{ name: 'install', stdout: huge }], footprintDelta: { tools: ['web_search'], entries: [{ id: 'a' }] } },
  })
  const two = shard(join(root, 's2'), HOST, [
    { name: 'c', version: '2.0.0', level: 'V3', result: 'results/c.json' },
  ], { 'results/c.json': { ok: true, stages: [], footprintDelta: { tools: ['web_search'], entries: [{ id: 'c' }] } } })
  const wrong = shard(join(root, 's3'), '0.2.1-rc.5', [{ name: 'd', level: 'V3' }])
  const out = join(root, 'out')
  const document = merge(HOST, out, [one, two, wrong])
  assert.deepEqual(document.plugins.map((row) => row.name), ['a', 'b', 'c'])
  const b = document.plugins.find((row) => row.name === 'b')
  assert.equal(b.level, null)
  assert.equal(b.failure.kind, 'missing-servicescript')
  assert.equal(b.result, null)
  assert.ok(!existsSync(join(root, 'escape.json')))
  assert.match(document.rejectedInputs[0], /is not 0\.2\.2-rc\.1/u)
  const a = JSON.parse(readFileSync(join(out, 'results', 'a.json'), 'utf8'))
  assert.ok(a.stages[0].stdout.length < 20_000, 'logs are truncated')
  assert.match(a.stages[0].stdout, /truncated/u)
  assert.deepEqual(document.conflicts, [{ kind: 'tool-name', name: 'web_search', plugins: ['a@1.0.0', 'c@2.0.0'], predicted: true }],
    'conflicts are recomputed across shards, not just within one')
  assert.deepEqual(document.counts, { V1: 0, V2: 0, V3: 2, none: 1, failures: { 'missing-servicescript': 1 } })
})

test('sanitizeResult refuses something that is not a smoke report', () => {
  assert.equal(sanitizeResult(null), null)
  assert.equal(sanitizeResult({ stages: 'nope' }), null)
  assert.equal(sanitizeResult({ stages: [] }).stages.length, 0)
})

test('plan skips GitHub-only rows: there is no package to install', () => {
  const matrix = { plugins: [{ name: 'gh', version: '1.0.0', source: 'github', results: { [HOST]: { compatible: true } } }, { name: 'npm', version: '1.0.0', results: { [HOST]: { compatible: true } } }] }
  assert.deepEqual(plan(matrix, { plugins: [] }, HOST, 10), ['npm@1.0.0'])
})

test('merge keeps the trial profile composition, and only official bundle names', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-health-merge-profile-'))
  const dir = join(root, 's1')
  mkdirSync(join(dir, 'results'), { recursive: true })
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ host: { version: HOST }, profile: { hostBundles: ['@deepseek-ai/dsh-web-app', 'evil-pkg', 42] }, plugins: [] }))
  const document = merge(HOST, join(root, 'out'), [dir])
  assert.deepEqual(document.profile, { base: '@deepseek-ai/dsh-base', hostBundles: ['@deepseek-ai/dsh-web-app'] })
})
