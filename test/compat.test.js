import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluatePluginCompatibility,
  satisfiesDshRange,
  unmetRequirements,
} from '../src/compat/evaluate.js'

const runtime = '0.2.1-rc.2'

test('satisfiesDshRange includes prereleases and rejects empty ranges', () => {
  assert.equal(satisfiesDshRange(runtime, '>=0.2.0-rc.2'), true)
  assert.equal(satisfiesDshRange(runtime, '^0.2.0-rc.1'), true)
  assert.equal(satisfiesDshRange(runtime, ''), false)
  assert.equal(satisfiesDshRange(runtime, '>=0.3.0'), false)
})

test('engines.dsh decides alone', () => {
  const manifest = {
    name: 'plugin-a',
    version: '1.0.0',
    engines: { dsh: '>=0.2.0-rc.2' },
    peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0' },
  }
  assert.equal(evaluatePluginCompatibility(manifest, { runtimeVersion: runtime }), undefined)
})

test('an unmatched engines.dsh range is reported', () => {
  const issue = evaluatePluginCompatibility({
    name: 'plugin-a',
    version: '1.0.0',
    engines: { dsh: '0.2.0-rc.2' },
  }, { runtimeVersion: runtime })
  assert.deepEqual(issue, {
    name: 'plugin-a',
    version: '1.0.0',
    runtimeVersion: runtime,
    requirements: { 'engines.dsh': '0.2.0-rc.2' },
    exempted: false,
  })
})

test('peers are the fallback and only @deepseek-ai/dsh* peers count', () => {
  const compatible = { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-settings': '^0.2.0-rc.1', cordis: '^1.0.0' } }
  assert.equal(evaluatePluginCompatibility(compatible, { runtimeVersion: runtime }), undefined)
  const issue = evaluatePluginCompatibility({
    name: 'p',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0' },
  }, { runtimeVersion: runtime })
  assert.deepEqual(issue.requirements, { '@deepseek-ai/dsh-settings': '^0.1.0' })
})

test('workspace peers map to the running host version', () => {
  const manifest = { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-settings': 'workspace:^' } }
  assert.equal(evaluatePluginCompatibility(manifest, { runtimeVersion: runtime }), undefined)
})

test('exact-version exemptions are reported', () => {
  const issue = evaluatePluginCompatibility({
    name: 'p',
    version: '1.0.0',
    engines: { dsh: '>=0.3.0' },
  }, { runtimeVersion: runtime, exemptions: { 'p@1.0.0': [runtime] } })
  assert.equal(issue.exempted, true)
})

test('malformed inputs throw', () => {
  assert.throws(() => evaluatePluginCompatibility({}, { runtimeVersion: 'not-semver' }), /Invalid dsh runtime version/u)
  assert.throws(() => evaluatePluginCompatibility({ engines: { dsh: '>=0.3.0' } }, { runtimeVersion: runtime }), /name must be a non-empty string/u)
  assert.throws(() => evaluatePluginCompatibility({ name: 'p', version: '1.0.0', engines: { dsh: 42 } }, { runtimeVersion: runtime }), /engines\.dsh must be a string/u)
  assert.deepEqual(unmetRequirements({ name: 'p', version: '1.0.0' }, runtime), {})
})
