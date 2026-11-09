import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRuntimeSmoke } from '../src/runtime/smoke.js'

// A4 wiring. The unit tests cover the allowlist; this one covers the claim that a smoke run actually uses it,
// because a correct module nobody calls protects nothing.

/** A host directory the smoke run accepts, and a process double that records what it was handed. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-env-wiring-'))
  const host = join(directory, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', bin: { dsh: 'lib/bin.js' },
  }))
  return { directory, dshDirectory: host, plugin: 'fixture-plugin@1.0.0', tools: ['fixture_tool'], out: directory }
}

const success = { ok: true, exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', truncated: false }

/**
 * Run a smoke pass with a recording process double.
 * @param {object} options
 */
async function runWith(options) {
  const seen = []
  let call = 0
  const report = await runRuntimeSmoke(options, {
    runProcess: async (args, settings) => {
      seen.push(settings.env)
      call += 1
      // The second invocation is the worker; it must leave a report behind or the run reports failure.
      if (call === 2) writeFileSync(args.at(-1).replace(/config\.json$/u, 'runtime.json'),
        JSON.stringify({ ok: true, stage: 'complete', assertions: { registered: ['fixture_tool'], executed: [] } }))
      return success
    },
  })
  return { report, seen }
}

test('a cleaned smoke run hands the install and the worker a filtered environment', async () => {
  const options = fixture()
  const previous = process.env.FAKE_API_TOKEN
  process.env.FAKE_API_TOKEN = 'do_not_leak'
  try {
    const { report, seen } = await runWith({ ...options, cleanEnv: true })

    assert.equal(report.env.mode, 'clean')
    assert.ok(report.env.passed.some((name) => name.toLowerCase() === 'path'),
      `PATH has to survive or nothing installs; passed: ${report.env.passed.join(', ')}`)
    assert.equal(report.env.passed.some((name) => name === 'FAKE_API_TOKEN'), false)

    for (const env of seen) {
      assert.equal(env.FAKE_API_TOKEN, undefined, 'the token must not reach either process')
      assert.equal(env.DSH_HOME, report.home)
      assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
      const pathName = Object.keys(env).find((name) => name.toLowerCase() === 'path')
      assert.ok(typeof pathName === 'string' && env[pathName] !== '', 'PATH must survive')
    }
  } finally {
    if (previous === undefined) delete process.env.FAKE_API_TOKEN
    else process.env.FAKE_API_TOKEN = previous
    rmSync(options.directory, { recursive: true, force: true })
  }
})

test('without the flag the environment is inherited, and the report says so', async () => {
  const options = fixture()
  const previous = process.env.FAKE_API_TOKEN
  process.env.FAKE_API_TOKEN = 'inherited_on_purpose'
  try {
    const { report, seen } = await runWith({ ...options })

    assert.equal(report.env.mode, 'inherited')
    assert.deepEqual(report.env.passed, [])
    assert.equal(seen[0].FAKE_API_TOKEN, 'inherited_on_purpose',
      'the old behaviour is preserved deliberately, not by accident')
  } finally {
    if (previous === undefined) delete process.env.FAKE_API_TOKEN
    else process.env.FAKE_API_TOKEN = previous
    rmSync(options.directory, { recursive: true, force: true })
  }
})