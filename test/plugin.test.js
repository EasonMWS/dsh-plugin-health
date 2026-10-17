import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { evaluatePluginCompatibility } from '../src/compat/evaluate.js'
import { apply, hostRuntimeVersion, inspectionText } from '../src/plugin.js'
import { formatInspection } from '../src/repair/format.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('package declares an installable DSH bundle', () => {
  assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(new URL('../cordis.patch.yml', import.meta.url)))
  assert.equal(typeof packageJson.engines?.dsh, 'string')
})

test('bundle patch inserts this package as one row', () => {
  const patch = parseYaml(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(patch))
  const insert = patch.find((entry) => Array.isArray(entry?.insert))
  assert.ok(insert !== undefined)
  assert.deepEqual(insert.insert, [{ id: 'plugin-health', name: packageJson.name }])
})

test('the bundle manifest is compatible with current DSH host versions', () => {
  for (const host of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-rc.2']) {
    assert.equal(
      evaluatePluginCompatibility(packageJson, { runtimeVersion: host }),
      undefined,
      `expected bundle to be compatible with ${host}`,
    )
  }
  assert.notEqual(evaluatePluginCompatibility(packageJson, { runtimeVersion: '0.3.0-rc.1' }), undefined)
})

test('plugin loading is harmless outside a DSH host', async () => {
  const calls = []
  const ctx = {
    tools: { register: () => calls.push('register') },
    logger: { debug: () => calls.push('debug') },
  }
  await apply(ctx)
  // Without @deepseek-ai/dsh-tools installed the dynamic import fails and the plugin logs debug.
  assert.deepEqual(calls, ['debug'])
})

test('inspectionText renders JSON from the configured DSH home', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-plugin-'))
  const profile = join(home, 'profiles', 'web')
  const previous = process.env.DSH_HOME
  try {
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }))
    process.env.DSH_HOME = home
    const text = inspectionText({ profile: 'web', json: true })
    const parsed = JSON.parse(text)
    assert.equal(parsed.profile, 'web')
    assert.ok(Array.isArray(parsed.findings))
    assert.match(formatInspection(parsed), /Summary: \d+ error\(s\)/u)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('hostRuntimeVersion is a version string or undefined', () => {
  const version = hostRuntimeVersion()
  assert.ok(version === undefined || typeof version === 'string')
})
