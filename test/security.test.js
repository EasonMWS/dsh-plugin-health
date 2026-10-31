import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStatusHandler, presentedKey, KEY_COOKIE } from '../src/ui/repair-route.js'
import { safeHandoffSegment, handoffDirectory } from '../src/rescue/handoff.js'
import { requireHostVersion, prepareRehearsalHost } from '../src/rescue/environment.js'
import { readProfilePatch, writeProfilePatch, disablePlugin } from '../src/rescue/boot.js'

// Security regressions. Each case reproduces an attack from an external review of 1.0.2, so a
// future change that reopens one of these holes fails here instead of in someone's profile.

function profile() {
  return mkdtempSync(join(tmpdir(), 'dsh-health-sec-'))
}

/** Minimal response double that records what was sent. */
function recorder() {
  const captured = { status: 0, body: undefined, headers: undefined }
  return {
    captured,
    res: {
      writeHead(status, headers) { captured.status = status; captured.headers = headers },
      end(payload) { captured.body = payload === undefined ? undefined : JSON.parse(payload) },
    },
  }
}

// --- F1: the control key must not be readable from the unauthenticated status route ----------

test('the status route does not put the control key in the body', async () => {
  const { captured, res } = recorder()
  const handler = createStatusHandler(async () => ({ schemaVersion: 4, issues: [] }), 'super-secret')
  await handler({ method: 'GET', headers: { host: '127.0.0.1:1234' } }, res)
  assert.equal(captured.status, 200)
  assert.equal(captured.body.repairKey, undefined, 'the key must never appear in the body')
  assert.equal(JSON.stringify(captured.body).includes('super-secret'), false,
    'the key must not leak anywhere in the payload')
})

test('the status route delivers the key as an HttpOnly, SameSite=Strict cookie', async () => {
  const { captured, res } = recorder()
  const handler = createStatusHandler(async () => ({ schemaVersion: 4 }), 'super-secret')
  await handler({ method: 'GET', headers: { host: '127.0.0.1:1234' } }, res)
  const cookie = captured.headers['set-cookie']
  assert.match(cookie, /HttpOnly/u, 'page scripts must not be able to read it')
  assert.match(cookie, /SameSite=Strict/u, 'it must not ride a cross-site request')
  assert.match(cookie, /Path=\//u)
})

test('presentedKey reads the cookie and the header, preferring the header', () => {
  assert.equal(presentedKey({ headers: { cookie: `${KEY_COOKIE}=from-cookie` } }), 'from-cookie')
  assert.equal(
    presentedKey({ headers: { cookie: `other=1; ${KEY_COOKIE}=c; x=2` } }), 'c',
    'the key must be found among other cookies',
  )
  assert.equal(
    presentedKey({ headers: { cookie: `${KEY_COOKIE}=c`, 'x-plugin-health-key': 'h' } }), 'h',
  )
  assert.equal(presentedKey({ headers: {} }), undefined)
  assert.equal(presentedKey({}), undefined)
})

// --- F3: a hostile version must not escape the handoff directory ----------------------------

test('a traversal in the plugin version stays inside the handoff root', () => {
  const profileDir = join(tmpdir(), 'fake-profile')
  const root = join(profileDir, 'plugin-health-handoff')
  for (const version of ['../../../evil', '..\\..\\evil', '1.0.0/../../../../x', 'npm:evil']) {
    const segment = safeHandoffSegment('pkg', version)
    assert.doesNotMatch(segment, /[/\\]/u, `separator survived in ${segment}`)
    assert.doesNotMatch(segment, /\.\./u, `traversal survived in ${segment}`)
    const directory = handoffDirectory(profileDir, 'pkg', version)
    assert.ok(
      directory === root || directory.startsWith(`${root}\\`) || directory.startsWith(`${root}/`),
      `${version} escaped to ${directory}`,
    )
  }
})

test('a traversal in the plugin name is contained too', () => {
  const profileDir = join(tmpdir(), 'fake-profile')
  const directory = handoffDirectory(profileDir, '../../etc', '1.0.0')
  assert.match(directory, /plugin-health-handoff/u)
  assert.doesNotMatch(directory, /\.\./u)
})

// --- F4/F5: a hostile host version must never reach npm ------------------------------------

test('a host version that is not exact semver is refused', () => {
  for (const bad of ['0.2.1; calc.exe', '0.2.1 && curl evil', 'npm:evil', 'git+https://x', 'file:../../etc', 'latest', '', undefined, null]) {
    assert.throws(() => requireHostVersion(bad), /exact version/u, `accepted ${JSON.stringify(bad)}`)
  }
})

test('a legitimate host version is accepted', () => {
  assert.equal(requireHostVersion('0.2.1-rc.5'), '0.2.1-rc.5')
  assert.equal(requireHostVersion(' 0.2.1 '), '0.2.1')
})

test('the host install runs without a shell and with lifecycle scripts disabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-sec-home-'))
  const calls = []
  await prepareRehearsalHost({
    home,
    version: '0.2.1-rc.5',
    runProcess: async (args, options) => { calls.push({ args, options }); return { ok: false, stderr: 'stub' } },
  }).catch(() => {})
  const [call] = calls
  assert.ok(call, 'the install should have been attempted')
  assert.equal(call.options.shell, undefined, 'no shell, so no argument can become syntax')
  assert.ok(call.args.includes('--ignore-scripts'), 'lifecycle scripts must not run')
  assert.ok(call.args.includes('@deepseek-ai/dsh@0.2.1-rc.5'), 'the spec stays a fixed package name')
  for (const arg of call.args) assert.doesNotMatch(String(arg), /[;&|`$]/u, `shell metacharacter in ${arg}`)
})

// --- F2: a patch layer we do not understand must not be overwritten ------------------------

test('a patch layer that is not a sequence is refused instead of being wiped', () => {
  const dir = profile()
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), 'bundles:\n  - "@deepseek-ai/dsh-base"\n')
    assert.throws(() => readProfilePatch(dir), /not a YAML sequence/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid YAML is refused with a code the caller can explain', () => {
  const dir = profile()
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), 'a: [unclosed\n')
    assert.throws(() => readProfilePatch(dir), (error) => error.code === 'PATCH_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writing the patch layer leaves a backup and keeps the user entries', () => {
  const dir = profile()
  try {
    const original = '- name: kept\n  disabled: false\n'
    writeFileSync(join(dir, 'cordis.patch.yml'), original)
    writeProfilePatch(dir, [{ name: 'kept', disabled: true }])
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml.bak-plugin-health'), 'utf8'), original,
      'the previous content must survive for recovery')
    assert.match(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), /kept/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disablePlugin refuses to run on a patch layer it cannot parse', () => {
  const dir = profile()
  try {
    const mapping = 'bundles:\n  - x\n'
    writeFileSync(join(dir, 'cordis.patch.yml'), mapping)
    assert.throws(() => disablePlugin(dir, { name: 'p', id: 'p' }), /not a YAML sequence/u)
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), mapping, 'the file must be untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
