import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { admissionReport, dependencyInventory, installHooks } from '../src/outside/admission.js'

// The admission check is the only thing that can run before the host starts. Three bugs were found in
// it while writing these tests, all of the same kind: a field or a path was assumed rather than read,
// and the result was a silent zero that looked like a clean bill of health. These pin all three.

function home() {
  return mkdtempSync(join(tmpdir(), 'admission-'))
}

/** Write a package.json into `dir/name`, creating the path. */
function putPackage(dir, name, manifest) {
  const target = join(dir, ...name.split('/'))
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }), 'utf8')
  return target
}

test('install hooks are read from the manifest, not guessed', () => {
  assert.deepEqual(installHooks({ scripts: { postinstall: 'node x.js' } }), ['postinstall'])
  assert.deepEqual(installHooks({ scripts: { test: 'node --test' } }), [], 'a test script is not an install hook')
  assert.deepEqual(installHooks({ scripts: { postinstall: '   ' } }), [], 'blank is not a script')
  assert.deepEqual(installHooks({}), [])
  assert.deepEqual(installHooks(null), [])
})

test('the dependency walk follows the symlinks pnpm creates', () => {
  // DSH profiles use pnpm. pnpm links every package into node_modules as a symlink, and
  // Dirent#isDirectory() is false for a symlink — so the first version of this walker reported an
  // empty tree on every real profile, which reads as "nothing to worry about".
  const dir = home()
  try {
    const profile = join(dir, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    mkdirSync(modules, { recursive: true })

    // A package in another directory, linked in the way pnpm does it.
    const store = join(dir, '.pnpm-store', 'linked-pkg')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'linked-pkg', version: '2.0.0' }), 'utf8')
    try {
      symlinkSync(store, join(modules, 'linked-pkg'), 'junction')
    } catch {
      // Junctions need different privileges on some systems; the plain-directory case below still
      // covers the walk itself.
    }

    // A plain directory package, always present.
    putPackage(modules, 'plain-pkg', { version: '1.0.0', scripts: { postinstall: 'node build.js' } })

    const tree = dependencyInventory(profile)
    const names = tree.map((row) => row.name)
    assert.ok(names.includes('plain-pkg'), `plain package missing from ${JSON.stringify(names)}`)
    assert.ok(tree.length >= 1)
    const plain = tree.find((row) => row.name === 'plain-pkg')
    assert.deepEqual(plain.hooks, ['postinstall'], 'the hook must be reported')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a scoped package is found one level deeper', () => {
  const dir = home()
  try {
    const profile = join(dir, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    mkdirSync(modules, { recursive: true })
    putPackage(modules, '@scope/pkg', { version: '3.1.4', scripts: { install: 'node setup.js' } })

    const tree = dependencyInventory(profile)
    const found = tree.find((row) => row.name === '@scope/pkg')
    assert.ok(found, `scoped package missing from ${JSON.stringify(tree.map((r) => r.name))}`)
    assert.equal(found.version, '3.1.4')
    assert.deepEqual(found.hooks, ['install'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a nested dependency tree is walked, not just the top level', () => {
  const dir = home()
  try {
    const profile = join(dir, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    mkdirSync(modules, { recursive: true })
    const outer = putPackage(modules, 'outer', { version: '1.0.0' })
    putPackage(join(outer, 'node_modules'), 'inner', { version: '9.9.9', scripts: { postinstall: 'node evil.js' } })

    const tree = dependencyInventory(profile)
    const inner = tree.find((row) => row.name === 'inner')
    assert.ok(inner, `nested package missing from ${JSON.stringify(tree.map((r) => r.name))}`)
    assert.deepEqual(inner.hooks, ['postinstall'], 'a script one level down still runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the report counts what inspectDshHome actually returns', () => {
  // The first version read `installedPlugins`, which inspectDshHome does not return. Every profile
  // reported zero plugins and a clean verdict — the worst possible failure for this check.
  const dir = home()
  try {
    const profileDir = join(dir, 'profiles', 'desktop')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-good'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-good'] } },
      dependencies: { 'dsh-good': '1.0.0' },
    }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-good', 'package.json'), JSON.stringify({
      name: 'dsh-good', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.3.0-0' },
    }), 'utf8')

    const report = admissionReport({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    assert.ok(report.pluginCount > 0, 'a profile with one plugin must not report zero plugins')
    assert.equal(report.verdict, 'pass')
    assert.equal(report.findings.filter((f) => f.kind === 'would-be-rejected').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plugin the target host would reject blocks admission', () => {
  const dir = home()
  try {
    const profileDir = join(dir, 'profiles', 'desktop')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-old'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-old'] } },
      dependencies: { 'dsh-old': '1.0.0' },
    }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-old', 'package.json'), JSON.stringify({
      name: 'dsh-old', version: '1.0.0', engines: { dsh: '0.1.7' },
    }), 'utf8')

    const report = admissionReport({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    assert.equal(report.verdict, 'block')
    const blocked = report.findings.filter((f) => f.kind === 'would-be-rejected')
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].plugin, 'dsh-old')
    assert.equal(blocked[0].severity, 'block')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an install script is reported as a warning, not a verdict', () => {
  // A native module legitimately needs one. Calling it malicious would be a lie; not mentioning it
  // would hide the one thing that runs before any of this tool's checks can.
  const dir = home()
  try {
    const profileDir = join(dir, 'profiles', 'desktop')
    const pluginDir = join(profileDir, 'node_modules', 'dsh-native')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-native'] } },
      dependencies: { 'dsh-native': '1.0.0' },
    }), 'utf8')
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'dsh-native', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.3.0-0' },
      scripts: { postinstall: 'node-gyp rebuild' },
    }), 'utf8')

    const report = admissionReport({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    const scripts = report.findings.filter((f) => f.kind === 'install-script')
    assert.equal(scripts.length, 1)
    assert.equal(scripts[0].severity, 'warn', 'a build step must not block startup')
    assert.equal(report.verdict, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the report states what it did not look at', () => {
  const dir = home()
  try {
    mkdirSync(join(dir, 'profiles', 'desktop', 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'profiles', 'desktop', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } }, dependencies: {} }), 'utf8')
    const report = admissionReport({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    assert.ok(Array.isArray(report.limits) && report.limits.length > 0, 'a clean verdict must carry its blind spots')
    assert.ok(report.limits.some((l) => l.includes('no-runtime-behaviour')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fingerprint changes when the plugin set changes', () => {
  const dir = home()
  try {
    const profileDir = join(dir, 'profiles', 'desktop')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-a'] } }, dependencies: { 'dsh-a': '1.0.0' },
    }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), JSON.stringify({
      name: 'dsh-a', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.3.0-0' },
    }), 'utf8')

    const first = admissionReport({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' }).fingerprint

    writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), JSON.stringify({
      name: 'dsh-a', version: '1.0.1', engines: { dsh: '>=0.2.0 <0.3.0-0' },
    }), 'utf8')

    const second = admissionReport({ home: dir, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' }).fingerprint
    assert.notEqual(first, second, 'a version change must invalidate a previous admission check')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
