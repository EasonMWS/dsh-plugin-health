import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRuntimeSmoke } from '../src/runtime/smoke.js'
import { readSubjects, toolIdentity } from '../src/runtime/evidence.js'

const success = { ok: true, exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', truncated: false }
const OWN = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-evidence-test-'))
  const host = join(directory, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', bin: { dsh: 'lib/bin.js' } }))
  return { directory, dshDirectory: host, plugin: 'fixture-plugin@1.0.0', bootOnly: true, out: directory }
}

const LOCK = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh-base':
        specifier: 0.2.2-rc.1
        version: 0.2.2-rc.1
      fixture-plugin:
        specifier: 1.0.0
        version: 1.0.0(@deepseek-ai/dsh-tools@0.2.2-rc.1)
packages:
  '@deepseek-ai/dsh-base@0.2.2-rc.1':
    resolution: {integrity: sha512-base}
  fixture-plugin@1.0.0:
    resolution: {integrity: sha512-fixture}
`

/** Pretend to be the official CLI: the install writes the profile the way pnpm would. */
function fakeHost({ lock = LOCK } = {}) {
  return async (args, settings) => {
    if (args.includes('add')) {
      const profile = join(settings.env.DSH_HOME, 'profiles', 'health-smoke')
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh-base': '0.2.2-rc.1', 'fixture-plugin': '1.0.0' } }))
      if (lock !== null) writeFileSync(join(profile, 'pnpm-lock.yaml'), lock)
      return success
    }
    const config = JSON.parse(readFileSync(args.at(-1), 'utf8'))
    writeFileSync(config.resultPath, JSON.stringify({ ok: true, stage: 'complete', hostCordis: '4.1.0' }))
    return success
  }
}

test('a smoke report records the tool, the runtime and what was actually installed', async () => {
  const report = await runRuntimeSmoke(fixture(), { runProcess: fakeHost(), probePnpm: async () => '11.7.0' })
  assert.equal(report.ok, true)
  assert.deepEqual(report.tool, { name: OWN.name, version: OWN.version })
  assert.equal(report.runtimeEnv.node, process.version)
  assert.equal(report.runtimeEnv.platform, process.platform)
  assert.equal(report.runtimeEnv.pnpm, '11.7.0')
  assert.equal(report.runtimeEnv.cordis, '4.1.0', 'the cordis version comes from the worker report')
  assert.deepEqual(report.subjects, [{ name: 'fixture-plugin', version: '1.0.0', integrity: 'sha512-fixture', resolution: 'registry' }])
  for (const stage of report.stages) {
    assert.match(stage.startedAt, /^\d{4}-\d{2}-\d{2}T/u, `${stage.name} has no start time`)
    assert.equal(typeof stage.durationMs, 'number')
    assert.ok(stage.durationMs >= 0)
  }
})

test('missing evidence is recorded as missing and does not fail the run', async () => {
  const report = await runRuntimeSmoke(fixture(), {
    runProcess: fakeHost({ lock: null }),
    probePnpm: async () => null,
  })
  assert.equal(report.ok, true, 'a passing run stays passing without a lockfile')
  assert.equal(report.runtimeEnv.pnpm, null)
  assert.equal(report.subjects.length, 1)
  assert.equal(report.subjects[0].name, 'fixture-plugin')
  assert.equal(report.subjects[0].integrity, null)
  assert.match(report.subjects[0].evidenceError, /pnpm-lock\.yaml not found/u)
})

test('a failed install still records what evidence there is', async () => {
  const report = await runRuntimeSmoke(fixture(), {
    runProcess: async () => ({ ...success, ok: false, exitCode: 1, stderr: 'rejected' }),
    probePnpm: async () => '11.7.0',
  })
  assert.equal(report.ok, false)
  assert.equal(report.stages.length, 1)
  assert.ok(Array.isArray(report.subjects))
  assert.equal(typeof report.stages[0].durationMs, 'number')
})

test('readSubjects follows the importer version, including a peer suffix, to the integrity', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-health-subjects-'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh-base': 'x', 'fixture-plugin': '1.0.0', local: 'file:../local' } }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), `${LOCK.replace('packages:', `      local:\n        specifier: file:../local\n        version: file:../local\npackages:`)}`)
  const subjects = readSubjects(profile)
  assert.deepEqual(subjects.map((row) => row.name), ['fixture-plugin', 'local'], 'official packages are the baseline, not subjects')
  assert.equal(subjects[0].integrity, 'sha512-fixture')
  assert.deepEqual(subjects[1], { name: 'local', version: null, integrity: null, resolution: 'file' })
})

test('readSubjects names a subject that is absent from the lockfile instead of dropping it', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-health-subjects-'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), LOCK)
  const [subject] = readSubjects(profile, ['not-installed'])
  assert.equal(subject.name, 'not-installed')
  assert.match(subject.evidenceError, /not in pnpm-lock\.yaml/u)
})

test('toolIdentity reads this package', () => {
  assert.deepEqual(toolIdentity(), { name: OWN.name, version: OWN.version })
})

test('footprint records entries and tool names from the public definitions()', async () => {
  const { describeFootprint } = await import('../src/runtime/worker.js')
  const entries = [
    { options: { id: 'a1', name: '@deepseek-ai/dsh-base' }, fiber: { state: 2 } },
    { options: { id: 'p1', name: 'plugin-x' }, fiber: { state: 0 }, disabled: true },
  ]
  const ctx = (tools) => ({ get: (name) => (name === 'loader' ? { entries: () => entries } : tools) })
  const withTools = describeFootprint(ctx({ definitions: () => [{ name: 'web_search' }, { name: 'bash' }, { name: 'web_search' }] }))
  assert.deepEqual(withTools, {
    entries: [
      { id: 'a1', name: '@deepseek-ai/dsh-base', state: 2, disabled: false },
      { id: 'p1', name: 'plugin-x', state: 0, disabled: true },
    ],
    tools: ['bash', 'web_search'],
    toolsUnavailable: false,
  })
})

test('a host without definitions(), or one that throws, records toolsUnavailable instead of failing', async () => {
  const { describeFootprint } = await import('../src/runtime/worker.js')
  const ctx = (tools) => ({ get: (name) => (name === 'loader' ? { entries: () => [] } : tools) })
  assert.deepEqual(describeFootprint(ctx({ get: () => null })), { entries: [], tools: [], toolsUnavailable: true })
  assert.deepEqual(describeFootprint(ctx(undefined)), { entries: [], tools: [], toolsUnavailable: true })
  assert.deepEqual(describeFootprint(ctx({ definitions: () => { throw new Error('scope missing') } })), { entries: [], tools: [], toolsUnavailable: true })
})

test('the booted tree gets --port 0 --no-open only when the web app is in the profile', async () => {
  const { launchArgs } = await import('../src/runtime/worker.js')
  assert.deepEqual(launchArgs({ webApp: true }), ['--port', '0', '--no-open'])
  assert.deepEqual(launchArgs({}), [])
  assert.deepEqual(launchArgs({ webApp: 'yes' }), [], 'only a real boolean, never a value taken from elsewhere')
})
