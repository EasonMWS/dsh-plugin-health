import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { availableIcons, installShortcuts, linuxDesktopEntry, macCommand, windowsShim } from '../src/outside/install.js'

// Installation writes outside the repository, so what matters here is that each platform's launcher
// is well formed and that a missing Desktop is reported rather than silently skipped.

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1').replace(/\//gu, '\\')

test('the windows shim quotes paths and pauses on failure', () => {
  // A shortcut that flashes and closes teaches the user nothing about why it failed.
  const shim = windowsShim({ root: 'C:\\root dir', profile: 'desktop' })
  assert.match(shim, /"C:\\root dir\\bin\\health-outside\.js"/u)
  assert.match(shim, /--profile desktop/u)
  assert.match(shim, /pause >nul/u, 'the window must stay open on failure')
  assert.match(shim, /health-outside\.js/u)
})

test('the mac command quotes paths and pauses on failure', () => {
  const command = macCommand({ root: '/opt/plugin health', profile: 'desktop' })
  assert.match(command, /^#!\/bin\/sh/u)
  assert.match(command, /"\/opt\/plugin health\/bin\/health-outside\.js"/u)
  assert.match(command, /read _/u, 'the window must stay open on failure')
})

test('the linux entry is a valid desktop file', () => {
  const entry = linuxDesktopEntry({ root: '/opt/ph', profile: 'desktop', icon: '/opt/ph/assets/icon-256.png' })
  assert.match(entry, /^\[Desktop Entry\]/u)
  assert.match(entry, /^Type=Application$/mu)
  assert.match(entry, /^Exec=/mu)
  assert.match(entry, /^Icon=\/opt\/ph\/assets\/icon-256\.png$/mu)
})

test('a missing Desktop is reported, not silently skipped', () => {
  const result = installShortcuts({ root: ROOT, desktop: join(tmpdir(), 'definitely-not-a-desktop-dir-xyz') })
  assert.equal(result.ok, false)
  assert.match(result.error, /no Desktop directory/u)
})

test('the icon assets that exist are reported', () => {
  const icons = availableIcons('D:/agent头脑风暴/dsh-plugin-health-notes/dsh-plugin-health')
  assert.ok(icons.some((path) => path.endsWith('icon.ico')), `expected an .ico among ${JSON.stringify(icons)}`)
  assert.ok(icons.every((path) => existsSync(path)), 'the list must only name files that exist')
})

test('the ico container is well formed', () => {
  // The icon is built by hand; a malformed container shows as a blank shortcut and nothing else, so it
  // is worth reading the header back.
  const path = 'D:/agent头脑风暴/dsh-plugin-health-notes/dsh-plugin-health/assets/icon.ico'
  const bytes = readFileSync(path)
  assert.equal(bytes.readUInt16LE(0), 0, 'reserved field')
  assert.equal(bytes.readUInt16LE(2), 1, 'type must be 1 (icon)')
  const count = bytes.readUInt16LE(4)
  assert.ok(count >= 1 && count <= 16, `unexpected image count ${count}`)

  // Every directory entry must point inside the file.
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16
    const size = bytes.readUInt32LE(base + 8)
    const offset = bytes.readUInt32LE(base + 12)
    assert.ok(offset + size <= bytes.length, `entry ${i} points past the end`)
    assert.ok(size > 0, `entry ${i} is empty`)
  }
})

test('the shim is written only where a Desktop exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-'))
  try {
    const fakeRoot = join(dir, 'root')
    mkdirSync(join(fakeRoot, 'assets'), { recursive: true })
    const fakeDesktop = join(dir, 'Desktop')
    mkdirSync(fakeDesktop, { recursive: true })

    const result = installShortcuts({ root: fakeRoot, desktop: fakeDesktop, profile: 'desktop' })
    assert.equal(result.ok, true)
    assert.ok(result.written.length >= 1)
    for (const path of result.written) {
      assert.ok(existsSync(path), `expected ${path} to exist`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
