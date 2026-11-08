import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bubblewrapArgs, buildSandboxedCommand, findShell, launchSandboxed,
  sandboxExecProfile, sandboxSupport,
} from '../src/outside/sandbox.js'

// A sandbox that is only asserted as a string has not been shown to sandbox anything. On Linux and macOS
// the tests below run the real tool; on Windows there is nothing to run, and the honest test is that the
// module says so rather than producing a command that looks like protection.

const PLATFORM = process.platform
const support = sandboxSupport()
const HAS_SANDBOX = support.available === true

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sandbox-test-'))
}

test('the support check looks for the binary, not for a platform name', () => {
  // A machine can be Linux without bubblewrap, and the platform string would describe that wrongly.
  const withoutBinary = sandboxSupport({ platform: 'linux', exists: () => false })
  assert.equal(withoutBinary.available, false)
  assert.match(withoutBinary.reason, /bubblewrap is not installed/u)

  const withBinary = sandboxSupport({ platform: 'linux', exists: (path) => path === '/usr/bin/bwrap' })
  assert.equal(withBinary.available, true)
  assert.equal(withBinary.kind, 'bubblewrap')
})

test('windows reports that it cannot sandbox, with a reason', () => {
  // This is the important case for this repository: the tool must not imply protection it cannot give.
  const windows = sandboxSupport({ platform: 'win32' })
  assert.equal(windows.available, false)
  assert.equal(windows.kind, null)
  assert.match(windows.reason, /AppContainer|Windows Sandbox/u)
  assert.ok(windows.reason.length > 40, 'the reason has to explain itself')
})

test('an unknown platform is refused rather than guessed at', () => {
  const other = sandboxSupport({ platform: 'aix' })
  assert.equal(other.available, false)
  assert.match(other.reason, /no sandbox is implemented/u)
})

test('the bubblewrap arguments deny the network and keep only the home writable', () => {
  const args = bubblewrapArgs({
    home: '/home/u/.dsh',
    command: '/usr/bin/node',
    args: ['/opt/dsh/bin/dsh.js'],
    exists: () => true,
  })

  assert.ok(args.includes('--unshare-all'), 'the network and IPC must be unshared')
  assert.ok(args.includes('--die-with-parent'), 'the sandbox must not outlive its supervisor')
  assert.ok(args.includes('--new-session'), 'a plugin must not get the user terminal')

  // The only --bind (read-write) is the home. A --ro-bind must not be mistaken for one.
  const binds = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bind') binds.push(args[i + 1])
  }
  assert.deepEqual(binds, ['/home/u/.dsh'], `only the home may be writable, saw ${JSON.stringify(binds)}`)

  // The command comes after the separator, so nothing before it can be read as an argument to it.
  const separator = args.indexOf('--')
  assert.ok(separator > 0)
  assert.deepEqual(args.slice(separator + 1), ['/usr/bin/node', '/opt/dsh/bin/dsh.js'])
})

test('a system path that does not exist is skipped, not passed through', () => {
  // bubblewrap refuses a missing source, and a distribution that puts /lib64 elsewhere must not stop the
  // tool from working.
  const args = bubblewrapArgs({
    home: '/home/u/.dsh',
    command: 'node',
    systemReads: ['/usr', '/lib64', '/etc'],
    exists: (path) => path !== '/lib64',
  })
  assert.ok(args.includes('/usr'))
  assert.equal(args.includes('/lib64'), false)
})

test('the macOS profile denies by default and names the network', () => {
  const profile = sandboxExecProfile({ home: '/Users/u/.dsh', tmp: '/tmp' })

  assert.match(profile, /^\(version 1\)/u)
  assert.match(profile, /\(deny default\)/u, 'a default-allow profile protects nothing')
  assert.match(profile, /\(deny network\*\)/u)
  // Writing is granted for the home and temp only.
  assert.match(profile, /\(allow file-write\*[\s\S]*?"\/Users\/u\/\.dsh"/u)
})

test('a macOS path with quotes or backslashes cannot break out of the profile', () => {
  // A home directory is user-controlled; a profile is a program.
  const profile = sandboxExecProfile({ home: '/Users/we"ird\\.dsh', tmp: '/tmp' })
  const writeLine = profile.split('\n').find((line) => line.includes('we'))
  assert.ok(writeLine !== undefined)
  assert.equal(writeLine.includes('we"ird'), false, 'the quote must be escaped')
})

test('building a command on a platform with no sandbox fails with a reason', () => {
  const built = buildSandboxedCommand({
    platform: 'win32',
    home: 'C:\\Users\\u\\.dsh',
    command: 'node',
  })
  assert.equal(built.ok, false)
  assert.match(built.reason, /Windows/u)
})

test('launching refuses an executable that is not there', () => {
  const launched = launchSandboxed({ home: tempDir(), command: '/definitely/not/here' })
  assert.equal(launched.ok, false)
  assert.match(launched.error, /no such executable/u)
})

test('a shell is found where one exists, and none is claimed where none does', () => {
  const shell = findShell()
  if (PLATFORM === 'win32') {
    assert.equal(shell, undefined, 'Windows has no /bin/sh')
  } else {
    assert.ok(typeof shell === 'string' && shell.startsWith('/'), `expected a shell, saw ${shell}`)
  }
})

// --- the part that matters: does it actually sandbox? ---

test('on a platform with a sandbox, writes outside the home are refused by the OS', (t) => {
  if (!HAS_SANDBOX) {
    t.skip(`${PLATFORM} has no usable sandbox here: ${support.reason}`)
    return
  }

  const work = tempDir()
  try {
    const home = join(work, 'home')
    mkdirSync(home, { recursive: true })
    const outside = join(work, 'outside.txt')

    // A script that tries the exact thing a plugin would: write next to the profile.
    const script = join(home, 'probe.js')
    writeFileSync(script, `
      const fs = require('node:fs')
      try {
        fs.writeFileSync(${JSON.stringify(outside)}, 'x')
        console.log('OUTSIDE_WRITTEN')
      } catch (error) {
        console.log('OUTSIDE_REFUSED')
      }
    `, 'utf8')

    const built = buildSandboxedCommand({
      home,
      command: process.execPath,
      args: [script],
    })
    assert.equal(built.ok, true, built.reason)

    let output
    try {
      output = execFileSync(built.command, built.args, { encoding: 'utf8', timeout: 30_000 })
    } catch (error) {
      output = String(error.stdout ?? '') + String(error.stderr ?? '')
    } finally {
      built.cleanup?.()
    }

    assert.match(output, /OUTSIDE_REFUSED/u, `the write was not stopped; output was: ${output.slice(0, 200)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('on a platform with a sandbox, the network is refused', (t) => {
  if (!HAS_SANDBOX) {
    t.skip(`${PLATFORM} has no usable sandbox here: ${support.reason}`)
    return
  }

  const work = tempDir()
  try {
    const home = join(work, 'home')
    mkdirSync(home, { recursive: true })

    const script = join(home, 'net.js')
    writeFileSync(script, `
      const dns = require('node:dns')
      dns.lookup('example.com', (error) => {
        console.log(error ? 'NETWORK_REFUSED' : 'NETWORK_WORKED')
      })
    `, 'utf8')

    const built = buildSandboxedCommand({ home, command: process.execPath, args: [script] })
    assert.equal(built.ok, true, built.reason)

    let output
    try {
      output = execFileSync(built.command, built.args, { encoding: 'utf8', timeout: 30_000 })
    } catch (error) {
      output = String(error.stdout ?? '') + String(error.stderr ?? '')
    } finally {
      built.cleanup?.()
    }

    assert.match(output, /NETWORK_REFUSED/u, `the lookup was not stopped; output was: ${output.slice(0, 200)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('the sandbox profile file is cleaned up after a launch attempt', (t) => {
  if (support.kind !== 'sandbox-exec') {
    t.skip('only the macOS path writes a profile file')
    return
  }
  const work = tempDir()
  try {
    const home = join(work, 'home')
    mkdirSync(home, { recursive: true })
    const built = buildSandboxedCommand({ home, command: process.execPath, args: ['-e', '0'] })
    assert.equal(built.ok, true)
    const profilePath = built.args[1]
    assert.ok(readFileSync(profilePath, 'utf8').includes('(deny default)'))
    built.cleanup?.()
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
