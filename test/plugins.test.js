import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { disabledNames, listPlugins, setPluginEnabled } from '../src/outside/plugins.js'
import { hostStatus, recordHost } from '../src/outside/hostlock.js'
import { disablePlugin } from '../src/rescue/boot.js'
import { takeSnapshot } from '../src/outside/snapshot.js'

// A standalone manager is the only surface left when DSH will not start. What it must get right: it reports
// what is actually installed and actually on, and it refuses to write when writing would corrupt a profile
// something else is using.

/**
 * A profile with one host package and two third-party plugins.
 * @param {{disabled?: string[]}} [options]
 */
function makeHome({ disabled = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'plugins-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

  const put = (name, manifest) => {
    const dir = join(profileDir, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
  }

  put('@deepseek-ai/dsh-base', { name: '@deepseek-ai/dsh-base', version: '0.2.1' })
  put('dsh-good', { name: 'dsh-good', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.3.0-0' } })
  put('dsh-old', { name: 'dsh-old', version: '1.0.0', engines: { dsh: '0.1.7' } })

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-good', 'dsh-old'] } },
    dependencies: { 'dsh-good': '1.0.0', 'dsh-old': '1.0.0' },
  }), 'utf8')

  // Written as the tool itself would write it: enablePlugin only removes overlays that carry its marker,
  // so a hand-written one would be a different case than the one under test.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  for (const name of disabled) {
    disablePlugin(profileDir, { name })
  }

  return { home, profileDir }
}

test('the list reports what is installed, its real version, and whether it is on', () => {
  const { home } = makeHome({ disabled: ['dsh-old'] })
  try {
    const result = listPlugins({ home, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    assert.equal(result.ok, true)

    const good = result.plugins.find((row) => row.name === 'dsh-good')
    assert.ok(good, 'dsh-good must be listed')
    assert.equal(good.version, '1.0.0', 'the version comes from the manifest on disk')
    assert.equal(good.enabled, true)
    assert.equal(good.compatibility, 'compatible')

    const old = result.plugins.find((row) => row.name === 'dsh-old')
    assert.equal(old.enabled, false, 'the disable overlay must be read')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a plugin whose declaration excludes the host is reported incompatible, with the reason', () => {
  // This is the judgement the manager exists for: it has to agree with what the host will conclude.
  const { home } = makeHome()
  try {
    const result = listPlugins({ home, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    const old = result.plugins.find((row) => row.name === 'dsh-old')
    assert.equal(old.compatibility, 'incompatible')
    assert.match(old.reason, /engines\.dsh/u)
    assert.match(old.reason, /0\.1\.7/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the host\'s own packages are flagged, not offered as switchable plugins', () => {
  // Turning off @deepseek-ai/dsh-base turns off DSH. The list may count it, but the count of things a
  // manager can act on must not include it.
  const { home } = makeHome()
  try {
    const result = listPlugins({ home, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    const host = result.plugins.find((row) => row.name === '@deepseek-ai/dsh-base')
    assert.equal(host.hostPackage, true)
    assert.equal(result.counts.manageable, 2, `expected 2 manageable, saw ${result.counts.manageable}`)
    assert.equal(result.counts.total, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a disable overlay for a plugin that is gone is still reported', () => {
  // It is patch residue, and it is what the user will ask about when the plugin comes back.
  const { home, profileDir } = makeHome()
  try {
    disablePlugin(profileDir, { name: 'ghost-plugin' })
    const result = listPlugins({ home, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    const ghost = result.plugins.find((row) => row.name === 'ghost-plugin')
    assert.ok(ghost, 'the overlay must be visible')
    assert.equal(ghost.enabled, false)
    assert.match(ghost.reason, /not installed/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a profile that does not exist is reported, not treated as empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'plugins-missing-'))
  try {
    const result = listPlugins({ home, profile: 'nope', runtimeVersion: '0.2.2-rc.1' })
    assert.equal(result.ok, false)
    assert.match(result.error, /no profile/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('disabling a plugin writes the overlay and takes a snapshot first', () => {
  const { home, profileDir } = makeHome()
  try {
    const result = setPluginEnabled({
      home,
      profile: 'desktop',
      name: 'dsh-old',
      enabled: false,
      runtimeVersion: '0.2.2-rc.1',
      takeSnapshot,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.changed, true)
    assert.ok(typeof result.snapshot === 'string' && result.snapshot !== '', 'a snapshot must be taken first')

    // The overlay is on disk and the list agrees.
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /dsh-old/u)
    assert.match(patch, /disabled: true/u)

    const after = listPlugins({ home, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    assert.equal(after.plugins.find((row) => row.name === 'dsh-old').enabled, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('enabling a plugin removes the overlay', () => {
  const { home } = makeHome({ disabled: ['dsh-old'] })
  try {
    const result = setPluginEnabled({
      home, profile: 'desktop', name: 'dsh-old', enabled: true, runtimeVersion: '0.2.2-rc.1', takeSnapshot,
    })
    assert.equal(result.ok, true, result.error)

    const after = listPlugins({ home, profile: 'desktop', runtimeVersion: '0.2.2-rc.1' })
    const row = after.plugins.find((entry) => entry.name === 'dsh-old')
    assert.equal(row.enabled, true, `still disabled: ${row.reason}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the manager refuses to change state while the host is running', () => {
  // The host reads cordis.patch.yml at startup and may rewrite it. Writing underneath it is how a profile
  // ends up in a state nobody planned.
  const { home } = makeHome()
  try {
    // This test process is the "running host".
    recordHost(home, 'desktop', { pid: process.pid, source: 'test' })
    assert.equal(hostStatus(home, 'desktop').running, true)

    const result = setPluginEnabled({
      home, profile: 'desktop', name: 'dsh-old', enabled: false, runtimeVersion: '0.2.2-rc.1', takeSnapshot,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'host-running')
    assert.match(result.error, /close it/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a write that cannot be snapshotted does not happen', () => {
  // The snapshot is what makes the write reversible. Without it the operation has no way back.
  const { home, profileDir } = makeHome()
  try {
    const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const result = setPluginEnabled({
      home,
      profile: 'desktop',
      name: 'dsh-old',
      enabled: false,
      runtimeVersion: '0.2.2-rc.1',
      takeSnapshot: () => ({ ok: false, error: 'disk full' }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'snapshot-failed')
    assert.match(result.error, /disk full/u)
    assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), before, 'nothing may be written')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('enabling a plugin that is not installed is refused', () => {
  const { home } = makeHome()
  try {
    const result = setPluginEnabled({
      home, profile: 'desktop', name: 'never-heard-of-it', enabled: true, runtimeVersion: '0.2.2-rc.1', takeSnapshot,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-installed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('disable overlays are read by name and by id', () => {
  // The patch layer matches either, so a reader that only understands one of them misses half the states.
  const { home, profileDir } = makeHome()
  try {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: dsh-by-id',
      '  disabled: true',
      '- name: dsh-by-name',
      '  disabled: true',
      '- name: dsh-enabled',
      '  disabled: false',
      '',
    ].join('\n'), 'utf8')

    const names = disabledNames(profileDir)
    assert.ok(names.has('dsh-by-id'), 'the id form must be read')
    assert.ok(names.has('dsh-by-name'), 'the name form must be read')
    assert.equal(names.has('dsh-enabled'), false, 'disabled: false is not disabled')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})