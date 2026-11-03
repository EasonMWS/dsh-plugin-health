import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRescueHandlers } from '../src/ui/rescue-route.js'
import { runRuntimeSmoke } from '../src/runtime/smoke.js'
import { verifyActivation } from '../src/runtime/worker.js'
import { discoverDshDirectory } from '../src/rescue/environment.js'

// Three findings from the 2.0.0 review, each of which made a fix from the previous round ineffective:
//
//   1. the plugin identity travelled as a string, and a directory on the process's cwd named like a
//      spec (`foo@1.0.0/`) decided what actually got installed and exempted;
//   2. discovery was told which host to look for only in the version-arguable case — the route and
//      the CLI both called it without a version, so a cached host from a previous release was used;
//   3. the activation assertion matched entry ids by substring, so a neighbour satisfied it.

/** Build a throwaway profile with one installed plugin. */
function profileWithPlugin(name = 'foo', version = '1.0.0') {
  const home = mkdtempSync(join(tmpdir(), 'ident-'))
  const profileDir = join(home, 'profiles', 'p')
  mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
  return { home, profileDir }
}

test('a smoke run told its identity never treats the spec as a path', async () => {
  // The spec is a string the caller chose. If it happens to name an existing directory — relative to
  // the host process's cwd — the old code read the plugin identity out of that directory's manifest.
  const root = mkdtempSync(join(tmpdir(), 'ident-cwd-'))
  const previous = process.cwd()
  try {
    mkdirSync(join(root, 'foo@1.0.0'), { recursive: true })
    writeFileSync(join(root, 'foo@1.0.0', 'package.json'), JSON.stringify({ name: 'not-foo', version: '6.6.6' }))
    process.chdir(root)
    await assert.rejects(
      runRuntimeSmoke({ dshDirectory: '/nonexistent', plugin: 'foo@1.0.0', pluginName: 'foo', pluginVersion: '1.0.0', registryOnly: true, bootOnly: true }),
      // It still fails, but on the host directory rather than by installing the directory it found.
      (error) => !/not-foo/u.test(error.message),
    )
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a registry-only run refuses to guess the identity from a spec', async () => {
  await assert.rejects(
    runRuntimeSmoke({ dshDirectory: '/nonexistent', plugin: 'foo@1.0.0', registryOnly: true, bootOnly: true }),
    /needs the plugin name/u,
  )
})

test('the rescue route hands the rehearsal the identity it read from the manifest', async () => {
  const { home, profileDir } = profileWithPlugin()
  const seen = []
  const handlers = createRescueHandlers({
    currentProfile: () => ({ home, profile: 'p', profileDir, runtimeVersion: '0.2.1-rc.5' }),
    dshDirectoryOf: () => '/host/dsh',
    rehearseImpl: async (options) => {
      seen.push(options)
      return { verdict: 'broken', report: { stages: [], hostVersion: '0.2.1-rc.5' } }
    },
  })
  try {
    await handlers.rehearse({ plugin: 'foo', version: '1.0.0' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].pluginName, 'foo', 'the identity travels beside the spec, not inside it')
    assert.equal(seen[0].pluginVersion, '1.0.0')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('host discovery is asked for the running version, not just any host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ident-host-'))
  const profileDir = join(home, 'profiles', 'p')
  const seen = []
  try {
    const handlers = createRescueHandlers({
      currentProfile: () => ({ home, profile: 'p', profileDir, runtimeVersion: '0.2.1-rc.5' }),
      dshDirectoryOf: (...args) => { seen.push(args); return '/host/dsh' },
      rehearseImpl: async () => ({ verdict: 'broken', report: { stages: [], hostVersion: '0.2.1-rc.5' } }),
    })
    mkdirSync(join(profileDir, 'node_modules', 'foo'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'foo', 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }))
    await handlers.rehearse({ plugin: 'foo', version: '1.0.0' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0][2], '0.2.1-rc.5', 'without the version, any host on the machine is accepted')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a cached host of the wrong version is not discovered', () => {
  const home = mkdtempSync(join(tmpdir(), 'ident-cache-'))
  const profileDir = join(home, 'profiles', 'p')
  try {
    // A host left behind by an older release, in the pre-2.0.0 unversioned cache location.
    const stale = join(home, '.plugin-health', 'host', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }))

    const found = discoverDshDirectory(home, profileDir, '0.2.1')
    assert.notEqual(found, stale, 'a rehearsal must not run on a host from a previous release')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('activation is matched exactly, so a neighbour cannot satisfy it', () => {
  const entry = (id, name, extra = {}) => ({
    options: { id, name },
    fiber: extra.state === undefined ? undefined : { state: extra.state, inject: {}, ctx: { get: () => 1 } },
    disabled: extra.disabled,
  })
  const ctx = (list) => ({ get: (name) => (name === 'loader' ? { entries: () => list } : undefined) })

  // The plugin under test is disabled; a *different* package with a related id is active.
  assert.throws(
    () => verifyActivation(ctx([entry('dsh-x', 'dsh-x', { disabled: true }), entry('dsh-x-ui', 'dsh-x-ui', { state: 2 })]), { plugin: 'dsh-x' }),
    /did not activate|never entered/u,
  )
  // The plugin is absent; an unrelated entry's id merely contains its name.
  assert.throws(
    () => verifyActivation(ctx([entry('ui-kit', 'ui-kit', { state: 2 })]), { plugin: 'ui' }),
    /never entered/u,
  )
  assert.throws(
    () => verifyActivation(ctx([entry('@acme/a-helper', '@acme/a-helper', { state: 2 })]), { plugin: '@acme/a' }),
    /never entered/u,
  )
  // A disabled duplicate is enough for the plugin not to have loaded.
  assert.throws(
    () => verifyActivation(ctx([entry('foo', 'foo', { state: 2 }), entry('foo-2', 'foo', { disabled: true })]), { plugin: 'foo' }),
    /did not activate/u,
  )
  // And the real case still passes.
  assert.doesNotThrow(() => verifyActivation(ctx([entry('foo', 'foo', { state: 2 })]), { plugin: 'foo' }))
})

test('the disable overlay is validated as a package name', async () => {
  const { home, profileDir } = profileWithPlugin()
  const handlers = createRescueHandlers({
    currentProfile: () => ({ home, profile: 'p', profileDir, runtimeVersion: '0.2.1-rc.5' }),
    dshDirectoryOf: () => '/host/dsh',
  })
  try {
    await assert.rejects(handlers.disable({ plugin: '../../etc/passwd' }), /not a package name/u)
    await assert.rejects(handlers.enable({ plugin: 'not a name!' }), /not a package name/u)
    // A real name still works.
    const result = await handlers.disable({ plugin: 'foo' })
    assert.equal(result.disabled, true)
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /foo/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})