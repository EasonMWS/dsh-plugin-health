import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectPackageManager,
  installSnapshot,
  installUpdate,
  installedVersion,
  managerInvocation,
  resetInstallStateForTests,
} from '../src/ui/install.js'
import { createRescueHandlers, registerRescueRoute } from '../src/ui/rescue-route.js'
import { UPDATE_PATH } from '../src/ui/update.js'

// Updating this plugin from inside itself is the most dangerous thing the package does: it replaces
// the code DSH is currently booting from a profile. Every test here is about refusing to do it badly.

/** A profile directory with an installed copy at a given version. */
function profileWith(version = '2.0.0', { manager = 'pnpm' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'install-'))
  mkdirSync(join(dir, 'node_modules', 'dsh-plugin-health'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', 'dsh-plugin-health', 'package.json'),
    JSON.stringify({ name: 'dsh-plugin-health', version }),
  )
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', private: true }))
  if (manager === 'pnpm') {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    mkdirSync(join(dir, 'node_modules', '.pnpm'), { recursive: true })
  }
  return dir
}

/** A runner that pretends to install `to`, and records what it was asked to do. */
function fakeManager(to, { ok = true, code = 0, writeManifest = true } = {}) {
  const calls = []
  const runProcess = async ({ manager, args, cwd }) => {
    calls.push({ manager, args, cwd })
    if (ok && writeManifest) {
      writeFileSync(
        join(cwd, 'node_modules', 'dsh-plugin-health', 'package.json'),
        JSON.stringify({ name: 'dsh-plugin-health', version: to }),
      )
    }
    return { ok, code, output: 'Progress: resolved 1\nDone in 4s', timedOut: false }
  }
  return { calls, runProcess }
}

test('the package manager is detected from the profile, never assumed', () => {
  // Installing with npm into a pnpm workspace produces a tree neither tool can read, and the next
  // `dsh plugin add` then fails for a reason that has nothing to do with this plugin.
  assert.equal(detectPackageManager(profileWith('2.0.0', { manager: 'pnpm' })), 'pnpm')
  assert.equal(detectPackageManager(profileWith('2.0.0', { manager: 'npm' })), 'npm')

  // A lockfile alone is not enough — .pnpm holds the actual files.
  const halfMigrated = profileWith('2.0.0', { manager: 'pnpm' })
  rmSync(join(halfMigrated, 'node_modules', '.pnpm'), { recursive: true, force: true })
  assert.equal(detectPackageManager(halfMigrated), 'pnpm', 'the lockfile still says pnpm')

  const empty = mkdtempSync(join(tmpdir(), 'install-empty-'))
  assert.equal(detectPackageManager(empty), 'npm')
})

test('pnpm is told not to prompt and not to enforce the release-age gate', async () => {
  // pnpm asks about new releases and about supply-chain policy. In a process nobody is watching, a
  // prompt is a hang — so the flags that turn prompts into decisions have to be there.
  const dir = profileWith()
  const fake = fakeManager('2.1.6')
  await installUpdate({ profileDir: dir, version: '2.1.6', currentVersion: '2.0.0', runProcess: fake.runProcess })
  const [{ manager, args, cwd }] = fake.calls
  assert.equal(manager, 'pnpm')
  assert.equal(cwd, dir)
  assert.ok(args.includes('dsh-plugin-health@2.1.6'), 'the exact version, not a range')
  assert.ok(args.includes('--config.minimumReleaseAge=0'), 'a just-published version must be installable')
  assert.ok(args.some((a) => a.startsWith('--reporter')), 'no interactive progress renderer')
  // pnpm 12 removed --no-frozen-lockfile from `add`; passing it makes the whole install fail with a
  // usage error. -y is the flag that actually turns a prompt into an answer.
  assert.ok(args.includes('--yes'), 'prompts must be answered, not waited on')
  assert.ok(!args.includes('--no-frozen-lockfile'), 'this flag does not exist on pnpm 12 add')
})

test('a version is validated, because it ends up on a command line', async () => {
  resetInstallStateForTests()
  const dir = profileWith()
  const fake = fakeManager('2.1.6')
  for (const bad of ['2.0.0; rm -rf /', '$(whoami)', '../../etc', '', 'latest']) {
    resetInstallStateForTests()
    const state = await installUpdate({ profileDir: dir, version: bad, runProcess: fake.runProcess })
    assert.equal(state.phase, 'failed', `"${bad}" must be refused`)
    assert.match(state.error, /not a version/u)
  }
  assert.equal(fake.calls.length, 0, 'nothing may reach the package manager')
})

test('a failed install reports the package manager\u2019s own words', async () => {
  resetInstallStateForTests()
  const dir = profileWith()
  const state = await installUpdate({
    profileDir: dir,
    version: '9.9.9',
    runProcess: async () => ({
      ok: false,
      code: 1,
      output: 'Progress: resolved 1\r\nERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dsh-plugin-health: Not found',
      timedOut: false,
    }),
  })
  assert.equal(state.phase, 'failed')
  assert.match(state.error, /exited with code 1/u)
  // "exited with code 1" is not actionable; the reason is.
  assert.ok(state.log.some((line) => /FETCH_404/u.test(line)), `log should carry the reason, got ${JSON.stringify(state.log)}`)
  assert.ok(!state.log.some((line) => /^Progress/u.test(line)), 'progress noise is stripped')
})

test('a timeout is not reported as success', async () => {
  resetInstallStateForTests()
  const dir = profileWith()
  const state = await installUpdate({
    profileDir: dir,
    version: '2.1.6',
    timeoutMs: 1_000,
    runProcess: async () => ({ ok: false, code: null, output: '', timedOut: true }),
  })
  assert.equal(state.phase, 'failed')
  assert.match(state.error, /did not finish/u)
})

test('success is decided by what is on disk, not by the exit code', async () => {
  // A package manager can exit 0 and still leave the old files in place (a no-op add, a nested
  // workspace, a lockfile fight). Believing the exit code would produce a panel that claims an
  // update happened while the user keeps running the old code.
  resetInstallStateForTests()
  const dir = profileWith('2.0.0')
  const state = await installUpdate({
    profileDir: dir,
    version: '2.1.6',
    runProcess: async () => ({ ok: true, code: 0, output: 'Done', timedOut: false, writeManifest: false }),
  })
  assert.equal(state.phase, 'failed')
  assert.match(state.error, /reported success but 2\.0\.0 is on disk/u)
})

test('a successful install says the running host still has the old code', async () => {
  resetInstallStateForTests()
  const dir = profileWith('2.0.0')
  const fake = fakeManager('2.1.6')
  const state = await installUpdate({ profileDir: dir, version: '2.1.6', currentVersion: '2.0.0', runProcess: fake.runProcess })
  assert.equal(state.phase, 'done')
  assert.equal(state.targetVersion, '2.1.6')
  assert.equal(state.previousVersion, '2.0.0')
  // The files changed; the host did not. Saying so is the difference between honest and wrong.
  assert.equal(state.restartRequiredFrom, '2.0.0')
  assert.equal(installedVersion(dir), '2.1.6')
})

test('two clicks do not start two package managers against one directory', async () => {
  resetInstallStateForTests()
  const dir = profileWith()
  let started = 0
  const runProcess = async ({ cwd }) => {
    started += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(join(cwd, 'node_modules', 'dsh-plugin-health', 'package.json'),
      JSON.stringify({ name: 'dsh-plugin-health', version: '2.1.6' }))
    return { ok: true, code: 0, output: '', timedOut: false }
  }
  const [a, b] = await Promise.all([
    installUpdate({ profileDir: dir, version: '2.1.6', runProcess }),
    installUpdate({ profileDir: dir, version: '2.1.6', runProcess }),
  ])
  assert.equal(started, 1, 'the second call must join the first, not start another install')
  assert.equal(a.phase, 'done')
  assert.equal(b.phase, 'done')
})

test('the snapshot can be read without side effects', () => {
  resetInstallStateForTests()
  const snapshot = installSnapshot()
  assert.equal(snapshot.phase, 'idle')
  assert.deepEqual(snapshot.log, [])
})

test('the install action is reachable over the real route, and only with a key', async () => {
  const routes = new Map()
  const ctx = {
    inject: (_d, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } } }),
  }
  const KEY = 'k'.repeat(48)
  let installed = 0
  registerRescueRoute(ctx, {
    currentProfile: () => ({ home: '/tmp', profile: 'desktop', profileDir: '/tmp/profile', runtimeVersion: '0.2.1-rc.5' }),
    key: KEY,
    installUpdateImpl: async ({ profileDir, version }) => {
      installed += 1
      assert.equal(profileDir, '/tmp/profile')
      assert.equal(version, '9.9.9')
      return { phase: 'done', targetVersion: version, previousVersion: '2.0.0', restartRequiredFrom: '2.0.0', log: [] }
    },
  })
  const handler = routes.get(UPDATE_PATH)

  const body = JSON.stringify({ action: 'install', version: '9.9.9' })
  const mkReq = (headers) => ({
    method: 'POST',
    url: UPDATE_PATH,
    headers: { host: '127.0.0.1:5140', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  })
  const recorder = () => {
    const captured = { status: 0, body: undefined }
    return { captured, res: { writeHead(s) { captured.status = s }, end(p) { captured.body = p === undefined ? undefined : JSON.parse(p) } } }
  }

  const denied = recorder()
  await handler(mkReq({}), denied.res)
  assert.equal(denied.captured.status, 401, 'installing without a key must be refused')
  assert.equal(installed, 0)

  const allowed = recorder()
  await handler(mkReq({ 'x-plugin-health-key': KEY }), allowed.res)
  assert.equal(allowed.captured.status, 200)
  assert.equal(allowed.captured.body.phase, 'done')
  assert.equal(installed, 1)
})

test('a GET on the update route reports without installing', async () => {
  const routes = new Map()
  const ctx = {
    inject: (_d, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } } }),
  }
  const KEY = 'k'.repeat(48)
  let installed = 0
  registerRescueRoute(ctx, {
    currentProfile: () => ({ home: '/tmp', profile: 'desktop', profileDir: '/tmp/profile' }),
    key: KEY,
    installUpdateImpl: async () => { installed += 1; return { phase: 'done' } },
  })
  const captured = { status: 0, body: undefined }
  await routes.get(UPDATE_PATH)({
    method: 'GET',
    url: UPDATE_PATH,
    headers: { host: '127.0.0.1:5140', 'x-plugin-health-key': KEY },
  }, { writeHead(s) { captured.status = s }, end(p) { captured.body = JSON.parse(p) } })
  assert.equal(captured.status, 200)
  assert.equal(installed, 0, 'a read must never install')
  assert.ok(captured.body.install !== undefined, 'the read reports install state')
})

test('the invocation avoids a shell when a real executable is available', () => {
  // A .cmd shim needs shell:true, and shell:true concatenates arguments instead of escaping them.
  // pnpm ships a native executable and npm ships a JavaScript entry point, so a normal install needs
  // no shell — but CI installs pnpm on its own, outside the Node directory, so the fallback has to
  // stay available. This asserts the shape of each route rather than demanding one of them.
  for (const manager of ['pnpm', 'npm']) {
    const { command, args, shell } = managerInvocation(manager, ['add', 'x@1.0.0'])
    if (process.platform !== 'win32') {
      assert.equal(command, manager)
      assert.equal(shell, undefined)
    } else if (shell === true) {
      // A shell is acceptable only for the shim, and only when it is the shim being named.
      assert.equal(command, `${manager}.cmd`, `a shell is only for the .cmd shim, got ${command}`)
    } else {
      assert.ok(!command.endsWith('.cmd'), `${command} does not need a shell`)
    }
    // Whichever route is taken, the package spec stays one argument and is never re-split.
    assert.deepEqual(args.slice(-1), ['x@1.0.0'])
  }
})

test('the shim fallback names the shim and asks for a shell, on Windows only', () => {
  // CI installs pnpm outside the Node directory, so this route is real. It cannot be reached on a
  // machine with a bundled pnpm, so it is asserted by asking for a prefix with nothing under it.
  const empty = mkdtempSync(join(tmpdir(), 'no-manager-'))
  const { command, args, shell } = managerInvocation('pnpm', ['add', 'x@1.0.0'], { execPath: join(empty, 'node.exe') })
  if (process.platform === 'win32') {
    assert.equal(command, 'pnpm.cmd')
    assert.equal(shell, true)
    // The reason this is acceptable: everything on the command line is either a fixed flag or a
    // version this module matched against a strict pattern.
    assert.deepEqual(args, ['add', 'x@1.0.0'])
  } else {
    assert.equal(command, 'pnpm')
    assert.equal(shell, undefined)
  }
})

test('the spec stays a single argument, so nothing in it can become syntax', () => {
  const { args } = managerInvocation('pnpm', ['add', 'dsh-plugin-health@1.0.0'])
  assert.equal(args.filter((value) => value.includes('dsh-plugin-health')).length, 1)
  assert.ok(args.every((value) => typeof value === 'string' && !value.includes('\n')))
})
