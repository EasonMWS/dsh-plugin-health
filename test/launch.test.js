import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkAndLaunch, recordAdmission, resolveLauncher } from '../src/outside/launch.js'
import { readState } from '../src/state/shared.js'

// Launching the host is the one action here that has a real side effect, so most of these are about
// what the module refuses to do.

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'launch-'))
  const profileDir = join(dir, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: [] } }, dependencies: {},
  }), 'utf8')
  return dir
}

test('a blocking verdict does not start the host unless told to', () => {
  const dir = makeHome()
  try {
    const profileDir = join(dir, 'profiles', 'desktop')
    // A plugin whose declaration excludes the running version: admission will block.
    mkdirSync(join(profileDir, 'node_modules', 'dsh-old'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-old'] } }, dependencies: { 'dsh-old': '1.0.0' },
    }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-old', 'package.json'), JSON.stringify({
      name: 'dsh-old', version: '1.0.0', engines: { dsh: '0.1.7' },
    }), 'utf8')

    const result = checkAndLaunch({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1', start: false })
    assert.equal(result.report.verdict, 'block')
    assert.equal(result.launched, false)
    assert.match(result.stopped, /would not start cleanly/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the admission result is recorded before anything starts', () => {
  // A check nobody can find afterwards is not a check: the panel inside DSH needs to see that this
  // launch was checked, and against what.
  const dir = makeHome()
  try {
    const result = checkAndLaunch({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1', start: false })
    assert.equal(result.recorded.ok, true)

    const { state } = readState(dir)
    assert.equal(state.writer, 'outside')
    assert.ok(state.admission !== null, 'the admission result must be in the shared state')
    assert.equal(state.admission.profile, 'desktop')
    assert.ok(['pass', 'warn', 'block'].includes(state.admission.verdict))
    assert.ok(typeof state.admission.fingerprint === 'string' && state.admission.fingerprint.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a check that is not asked to start says so', () => {
  const dir = makeHome()
  try {
    const result = checkAndLaunch({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1', start: false })
    assert.equal(result.launched, false)
    assert.match(result.stopped, /not asked to start/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordAdmission refuses to write over an unreadable state file', () => {
  const dir = makeHome()
  try {
    mkdirSync(join(dir, '.plugin-health'), { recursive: true })
    writeFileSync(join(dir, '.plugin-health', 'state.json'), '{ broken', 'utf8')
    const result = recordAdmission(dir, { verdict: 'pass' })
    assert.equal(result.ok, false)
    assert.match(result.error, /unreadable/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the launcher resolves to something on this machine, or says why not', () => {
  const dir = makeHome()
  try {
    const launcher = resolveLauncher({ home: dir })
    // Either a real command, or a readable error. Never a silent empty result that would make the
    // caller think it launched something.
    const valid = typeof launcher.command === 'string' && launcher.command !== ''
      || typeof launcher.error === 'string' && launcher.error !== ''
    assert.ok(valid, JSON.stringify(launcher))
    if (launcher.error !== undefined) assert.ok(launcher.error.length > 10, 'the error must explain itself')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cli install is found through the profile when no desktop app is present', () => {
  // The desktop path is platform-specific and may or may not exist; a cli install is detectable from
  // the profile, so it is checked separately.
  const dir = makeHome()
  try {
    const hostDir = join(dir, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh', 'bin')
    mkdirSync(hostDir, { recursive: true })
    writeFileSync(join(hostDir, 'dsh.js'), '// entry\n', 'utf8')

    const launcher = resolveLauncher({ home: dir, execPath: '/usr/bin/node' })
    // On a machine with the desktop app installed, that wins — which is correct, and this assertion
    // only checks that when it does fall through, it falls through to something runnable.
    if (launcher.kind === 'cli') {
      assert.equal(launcher.command, '/usr/bin/node')
      assert.ok(launcher.args.some((arg) => arg.endsWith('dsh.js')))
    } else {
      assert.equal(launcher.kind, 'desktop')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
