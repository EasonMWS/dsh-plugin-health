import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePluginIdentity, runBoundedProcess, runRuntimeSmoke } from '../src/runtime/smoke.js'
import { verifyActivation, verifyTools } from '../src/runtime/worker.js'

// Retain each run so a failed test can be inspected using its smoke.json.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-runtime-test-'))
  const host = join(directory, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', bin: { dsh: 'lib/bin.js' } }))
  return { directory, dshDirectory: host, plugin: 'fixture-plugin@1.0.0', tools: ['fixture_tool'], out: directory }
}

const success = { ok: true, exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', truncated: false }

test('smoke installs and boots in the same isolated home and preserves runtime evidence', async () => {
  const options = fixture()
  const invocations = []
  const report = await runRuntimeSmoke(options, { runProcess: async (args, settings) => {
    invocations.push({ args, settings })
    if (invocations.length === 2) {
      const config = JSON.parse(readFileSync(args.at(-1), 'utf8'))
      assert.deepEqual(config.tools, ['fixture_tool'])
      writeFileSync(config.resultPath, JSON.stringify({ ok: true, stage: 'complete', assertions: { registered: ['fixture_tool'], executed: [] } }))
    }
    return success
  } })
  assert.equal(report.ok, true)
  assert.equal(report.hostVersion, '0.2.1-rc.3')
  assert.equal(invocations.length, 2)
  assert.deepEqual(invocations[0].args.slice(1), ['plugin', '--profile', 'health-smoke', 'add', 'fixture-plugin@1.0.0'])
  assert.equal(invocations[0].settings.env.DSH_HOME, report.home)
  assert.equal(invocations[1].settings.env.DSH_HOME, report.home)
  assert.notEqual(report.home, process.env.DSH_HOME)
  assert.equal(JSON.parse(readFileSync(join(report.directory, 'smoke.json'), 'utf8')).ok, true)
})

test('installation failure does not boot or claim runtime compatibility', async () => {
  let count = 0
  const report = await runRuntimeSmoke(fixture(), { runProcess: async () => {
    count += 1
    return { ...success, ok: false, exitCode: 1, stderr: 'incompatible fixture-plugin' }
  } })
  assert.equal(count, 1)
  assert.equal(report.ok, false)
  assert.equal(report.stages[0].name, 'install')
})

test('a timed-out boot retains its last stage and is failed even if shutdown exits zero', async () => {
  let count = 0
  const report = await runRuntimeSmoke(fixture(), { runProcess: async (args) => {
    if (++count === 1) return success
    const config = JSON.parse(readFileSync(args.at(-1), 'utf8'))
    writeFileSync(config.resultPath, JSON.stringify({ ok: false, stage: 'boot' }))
    return { ...success, ok: false, timedOut: true }
  } })
  assert.equal(report.ok, false)
  assert.equal(report.stages[1].details.stage, 'boot')
  assert.equal(report.stages[1].timedOut, true)
})

test('worker must complete, a zero exit without its report is not success', async () => {
  const report = await runRuntimeSmoke(fixture(), { runProcess: async () => success })
  assert.equal(report.ok, false)
  assert.equal(report.stages[1].ok, false)
  assert.match(report.stages[1].error, /without a runtime report/)
})

test('a partial runtime report retains the child diagnostic', async () => {
  let count = 0
  const report = await runRuntimeSmoke(fixture(), { runProcess: async (args) => {
    if (++count === 1) return success
    const config = JSON.parse(readFileSync(args.at(-1), 'utf8'))
    writeFileSync(config.resultPath, '{')
    return { ...success, ok: false, stderr: 'real plugin failure' }
  } })
  assert.equal(report.ok, false)
  assert.equal(report.stages[1].stderr, 'real plugin failure')
  assert.match(report.stages[1].error, /could not read/)
})

test('a launcher forcing a zero exit during shutdown cannot complete acceptance', async () => {
  const options = fixture()
  writeFileSync(join(options.dshDirectory, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', type: 'module', bin: { dsh: 'bin.js' },
    exports: { './profile-boot': './profile-boot.js' },
  }))
  writeFileSync(join(options.dshDirectory, 'profile-boot.js'), `
    export async function runProfile() {
      return {
        ctx: { get: name => name === 'loader' ? { entries: () => [] } : { get: () => ({}) }, fiber: { dispose: async () => {} } },
        shutdown: { shutdown: async () => { process.exit(0) } },
      }
    }
  `)
  const appBoot = join(options.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  mkdirSync(appBoot, { recursive: true })
  writeFileSync(join(appBoot, 'package.json'), JSON.stringify({ type: 'module', main: './index.js' }))
  writeFileSync(join(appBoot, 'index.js'), 'export const loadLayeredEnv = () => ({})\n')
  let count = 0
  const report = await runRuntimeSmoke(options, { runProcess: async (args, settings) => {
    if (++count === 1) return success
    return runBoundedProcess(args, settings)
  } })
  assert.equal(report.stages[1].exitCode, 0)
  assert.equal(report.stages[1].details.stage, 'shutdown')
  assert.equal(report.stages[1].details.ok, false)
  assert.equal(report.ok, false)
})

test('smoke validates assertions and the host before launching anything', async () => {
  await assert.rejects(runRuntimeSmoke({ ...fixture(), tools: [] }), /at least one/)
  await assert.rejects(runRuntimeSmoke({ ...fixture(), calls: [{ name: 'x' }] }), /calls must/)
  await assert.rejects(runRuntimeSmoke({ ...fixture(), timeoutMs: NaN }), /timeouts must/)
  await assert.rejects(runRuntimeSmoke({ ...fixture(), plugin: '--dangerous-option' }), /requires/)
})

test('tool probes name missing registrations, dispatch calls and check returned values', async () => {
  await assert.rejects(verifyTools({ get: () => undefined }, ['missing_tool'], []), /missing_tool/)
  const seen = []
  const ctx = { get: () => ({
    get: name => name === 'fixture_tool' ? {} : undefined,
    execute: async call => { seen.push(call); return { isError: false, value: { answer: 42 } } },
  }) }
  const result = await verifyTools(ctx, [], [{ name: 'fixture_tool', arguments: { input: 7 }, expectedValue: { answer: 42 } }])
  assert.deepEqual(result, { registered: ['fixture_tool'], executed: [{ name: 'fixture_tool', ok: true }] })
  assert.deepEqual(seen[0].arguments, { input: 7 })
  assert.ok(seen[0].signal instanceof AbortSignal)
  await assert.rejects(verifyTools(ctx, [], [{ name: 'fixture_tool', arguments: {}, expectedValue: 7 }]), /unexpected value/)
  const failing = { get: () => ({ get: () => ({}), execute: async () => ({ isError: true, content: 'failure' }) }) }
  await assert.rejects(verifyTools(failing, [], [{ name: 'fixture_tool', arguments: {} }]), /tool returned an error/)
})

test('activation audit rejects pending or missing entries even if other tools are available', () => {
  const entry = {
    options: { id: 'pending-row', name: 'pending-plugin' },
    fiber: { state: 0, inject: { obsoleteService: true }, ctx: { get: () => undefined } },
  }
  const ctx = { get: () => ({ entries: () => [entry] }) }
  assert.throws(() => verifyActivation(ctx), /pending-plugin.*waiting for obsoleteService/)
  entry.fiber.state = 2
  verifyActivation(ctx)
  entry.fiber = undefined
  assert.throws(() => verifyActivation(ctx), /pending-plugin.*not loaded/)
  entry.disabled = true
  verifyActivation(ctx)
  assert.throws(() => verifyActivation({ get: () => undefined }), /profile exited/)
})

test('process timeout force-stops a child that ignores SIGTERM', async () => {
  const result = await runBoundedProcess(['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    cwd: tmpdir(), env: process.env, timeoutMs: 200, killAfterMs: 100,
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('process output is bounded and marked as truncated', async () => {
  const result = await runBoundedProcess(['-e', "process.stdout.write('x'.repeat(100000)); process.stderr.write('failure')"], {
    cwd: tmpdir(), env: process.env, timeoutMs: 5000,
  })
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.equal(result.stdout.length, 65536)
  assert.equal(result.stderr, 'failure')
})

test('a successful parent leaving background descendants fails and stops their process group', { skip: process.platform === 'win32' }, async () => {
  const result = await runBoundedProcess(['-e', `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    child.unref()
    console.log(child.pid)
  `], { cwd: tmpdir(), env: process.env, timeoutMs: 5000, killAfterMs: 100 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.ok, false)
  assert.equal(result.orphaned, true)
  const pid = Number(result.stdout.trim())
  assert.ok(pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

// --- plugin identity resolution -------------------------------------------------------
// A CI run failed because a packed tarball was treated as a directory: `existsSync` is
// true for any path, so reading `<tarball>/package.json` threw instead of the smoke run
// proceeding. These tests pin the three shapes a plugin spec can take.

test('resolvePluginIdentity reads a local directory manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-identity-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '1.2.3' }))
  assert.deepEqual(resolvePluginIdentity(directory), { name: '@scope/pkg', version: '1.2.3' })
})

test('resolvePluginIdentity splits a registry spec, including scoped names', () => {
  assert.deepEqual(resolvePluginIdentity('pkg@1.2.3'), { name: 'pkg', version: '1.2.3' })
  assert.deepEqual(resolvePluginIdentity('@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' })
})

test('resolvePluginIdentity refuses a single file instead of reading it as a directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-identity-'))
  const tarball = join(directory, 'pkg-1.0.0.tgz')
  writeFileSync(tarball, 'not really a tarball')
  assert.throws(() => resolvePluginIdentity(tarball), /cannot read the plugin identity/u)
})

test('resolvePluginIdentity accepts an explicit identity for a tarball', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-identity-'))
  const tarball = join(directory, 'pkg-1.0.0.tgz')
  writeFileSync(tarball, 'not really a tarball')
  assert.deepEqual(
    resolvePluginIdentity(tarball, { name: '@scope/pkg', version: '1.0.0' }),
    { name: '@scope/pkg', version: '1.0.0' },
  )
})

test('resolvePluginIdentity rejects a bare name, which has no version to exempt', () => {
  assert.throws(() => resolvePluginIdentity('pkg'), /exact name@version/u)
})

test('a boot-only smoke run over a tarball never resolves the identity', async () => {
  // The regression: this used to throw during argument handling, before installing anything.
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-identity-'))
  const host = join(directory, 'host')
  mkdirSync(host, { recursive: true })
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.4', bin: { dsh: 'bin/dsh.mjs' } }))
  const tarball = join(directory, 'pkg-1.0.0.tgz')
  writeFileSync(tarball, 'not really a tarball')
  const report = await runRuntimeSmoke(
    { dshDirectory: host, plugin: tarball, bootOnly: true },
    { runProcess: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'install rejected by the host' }) },
  )
  assert.equal(report.ok, false)
  assert.equal(report.stages[0].name, 'install', 'the run must reach the install stage, not fail on identity')
})
