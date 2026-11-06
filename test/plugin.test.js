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
  // These are the versions this package has actually been installed into and booted against, not a
  // list copied from the range. The lower bound was narrowed to 0.2.0-rc.0 for exactly this reason:
  // anything below it was a promise nobody had tested, and 0.1.x belongs to an era of the host that
  // current users are not running.
  for (const host of ['0.2.0-rc.1', '0.2.1-rc.4', '0.2.2-rc.1']) {
    assert.equal(
      evaluatePluginCompatibility(packageJson, { runtimeVersion: host }),
      undefined,
      `expected bundle to be compatible with ${host}`,
    )
  }
  // Outside the declared range, and it has to say so rather than pass silently.
  for (const host of ['0.1.7-rc.2', '0.3.0-rc.1']) {
    assert.notEqual(
      evaluatePluginCompatibility(packageJson, { runtimeVersion: host }),
      undefined,
      `${host} is outside the declared range and must be reported`,
    )
  }
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
