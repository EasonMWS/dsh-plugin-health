/**
 * Run DSH inside an OS sandbox, where the OS provides one.
 *
 * Why this exists, and why only on two platforms:
 *
 * A plugin runs in the host process and inherits every right the host has. Measured on this machine: a
 * plugin can write outside the workspace, read any user file, and spawn a process. Nothing inside the
 * process can stop that — a guard in the same process is a guard the guarded code can reach.
 *
 * Node's own `--permission` model does block those things, and it was measured working — but only on the
 * Node path. Started as a GUI, the desktop host accepts the flag and ignores it: an app with no
 * filesystem rights at all still opened its window, which it could not have done if the model were in
 * force. Electron embeds Node as a library rather than invoking it, so the flag never reaches the part
 * that would enforce it.
 *
 * That leaves the operating system. Linux has bubblewrap, macOS has sandbox-exec. Windows has neither
 * AppContainer (needs native code and privileges this tool does not have) nor a job object that can
 * restrict the filesystem, so on Windows this module reports that it cannot sandbox rather than
 * pretending.
 *
 * What the sandbox is given: read access to the system, read-write to the DSH home only, no network, no
 * new privileges. Enough for DSH to run, not enough for a plugin to reach anything else.
 * @module outside/sandbox
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Paths a sandboxed DSH needs to read. Anything else is a decision, not a default. */
const SYSTEM_READS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/proc', '/sys', '/dev']

/** Where bubblewrap might be installed. */
const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap', '/snap/bin/bwrap']

/** Where sandbox-exec lives. It ships with macOS. */
const SANDBOX_EXEC_PATHS = ['/usr/bin/sandbox-exec', '/bin/sandbox-exec']

/** Shells that might exist, per platform. A sandbox with no shell cannot run the host. */
const SHELLS = {
  linux: ['/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash'],
  darwin: ['/bin/sh', '/bin/bash', '/bin/zsh'],
}

/**
 * Does this platform have a sandbox this module can drive?
 *
 * Looked up by finding the binary rather than by platform name: a Linux box without bubblewrap and a
 * Windows box with WSL are both cases a platform string would describe wrongly.
 *
 * @param {{platform?: string, exists?: (path: string) => boolean}} [options]
 * @returns {} | {available: false, kind: null, reason: string}}
 */
export function sandboxSupport({ platform = process.platform, exists = existsSync } = {}) {
  const find = (paths) => paths.find((path) => exists(path))

  if (platform === 'linux') {
    const binary = find(BWRAP_PATHS)
    if (binary !== undefined) return { available: true, kind: 'bubblewrap', binary, reason: '' }
    return {
      available: false,
      kind: null,
      reason: 'bubblewrap is not installed. Install it with your package manager (bubblewrap on Debian, Ubuntu, Fedora and Arch).',
    }
  }

  if (platform === 'darwin') {
    const binary = find(SANDBOX_EXEC_PATHS)
    // sandbox-exec is marked deprecated but still ships and still works.
    if (binary !== undefined) return { available: true, kind: 'sandbox-exec', binary, reason: '' }
    return { available: false, kind: null, reason: 'sandbox-exec is missing, which is unusual for macOS.' }
  }

  if (platform === 'win32') {
    return {
      available: false,
      kind: null,
      reason: 'Windows has no sandbox this tool can drive: AppContainer needs native code and privileges it does not have, and Windows Sandbox is not available on Home editions.',
    }
  }

  return { available: false, kind: null, reason: `no sandbox is implemented for ${platform}` }
}

/**
 * The bubblewrap command line.
 *
 * Deliberate choices:
 *   --unshare-all        no network, no new namespaces of its own, no IPC to the parent.
 *   --die-with-parent    the sandbox cannot outlive this tool.
 *   --new-session        no controlling terminal, so a plugin cannot hijack the user's.
 *
 * Absent system paths are skipped rather than passed through: bubblewrap refuses a missing source, and a
 * distribution that puts /lib64 somewhere else should not stop the tool from working.
 *
 * The network flag is a parameter because unsharing the network is not always possible: bringing up a
 * fresh namespace's loopback device needs CAP_NET_ADMIN, which unprivileged containers (including most
 * CI images) do not have. In that case bubblewrap exits before running anything, so the choice is
 * between a sandbox that starts without network isolation and no sandbox at all.
 *
 * @param {{
 *   home: string,
 *   command: string,
 *   args?: string[],
 *   systemReads?: string[],
 *   exists?: (path: string) => boolean,
 *   unshareNet?: boolean,
 * }} options
 * @returns {string[]}
 */
export function bubblewrapArgs({
  home,
  command,
  args = [],
  systemReads = SYSTEM_READS,
  exists = existsSync,
  unshareNet = true,
}) {
  // --unshare-all is the strong form. Without CAP_NET_ADMIN the network namespace cannot be set up, so
  // the individual namespaces are named instead and the network one is left out.
  const out = unshareNet
    ? ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev']
    : ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
       '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev']

  for (const path of systemReads) {
    if (exists(path)) out.push('--ro-bind', path, path)
  }

  // Read-only scratch system location, and the only writable tree: the DSH home.
  if (exists('/run')) out.push('--ro-bind', '/run', '/run')
  out.push('--bind', home, home)
  out.push('--tmpfs', '/tmp')
  out.push('--chdir', home)
  out.push('--', command, ...args)
  return out
}

/** Cache the network-isolation probe: it costs a process spawn and the answer cannot change. */
let networkIsolationCache

/**
 * Can this machine unshare the network namespace?
 *
 * Asked by running the cheapest possible bubblewrap command. A failure here is not an error to report —
 * it is the answer to the question, and it decides which form of the sandbox is used.
 *
 * @param {string} bwrap
 * @returns {boolean}
 */
export function canUnshareNetwork(bwrap) {
  if (networkIsolationCache !== undefined) return networkIsolationCache
  let ok = false
  try {
    execFileSync(bwrap, ['--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'], {
      stdio: 'pipe', timeout: 10_000,
    })
    ok = true
  } catch {
    ok = false
  }
  networkIsolationCache = ok
  return ok
}

/**
 * The sandbox-exec profile.
 *
 * Deny by default, then name what is permitted. Writes are limited to the DSH home and the temp
 * directory; the network is denied outright.
 *
 * @param {{home: string, tmp?: string}} options
 * @returns {string}
 */
export function sandboxExecProfile({ home, tmp = tmpdir() }) {
  const escapes = (value) => String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  const homePath = escapes(home)
  const tmpPath = escapes(tmp)

  return `(version 1)
; Deny by default: anything not named below is refused.
(deny default)

; Reading is needed for the host to load its own runtime.
(allow file-read*
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/private/var/db/dyld")
  (subpath "/opt")
  (subpath "/etc")
  (subpath "/dev")
  (subpath "/private/tmp")
  (subpath "${tmpPath}")
  (subpath "${homePath}"))

; Writing only inside the profile, plus the temp directory.
(allow file-write*
  (subpath "${homePath}")
  (subpath "${tmpPath}"))

; Enough process machinery for node to start and run.
(allow process-fork)
(allow process-exec)
(allow sysctl-read)
(allow mach-lookup)
(allow signal (target self))

; No network, in either direction.
(deny network*)
`
}

/**
 * Build the command that starts a sandboxed host.
 *
 * @param {{
 *   platform?: string,
 *   home: string,
 *   command: string,
 *   args?: string[],
 *   exists?: (path: string) => boolean,
 *   writeProfile?: (contents: string) => string,
 * }} options
 * @returns {{ok: true, command: string, args: string[], cleanup?: () => void} | {ok: false, reason: string}}
 */
export function buildSandboxedCommand({
  platform = process.platform,
  home,
  command,
  args = [],
  exists = existsSync,
  writeProfile,
  probeUnshare,
}) {
  const support = sandboxSupport({ platform, exists })
  if (support.available !== true) return { ok: false, reason: support.reason }

  if (support.kind === 'bubblewrap') {
    const unshareNet = probeUnshare === undefined ? canUnshareNetwork(support.binary) : probeUnshare
    return {
      ok: true,
      command: support.binary,
      args: bubblewrapArgs({ home, command, args, exists, unshareNet }),
      // Told, not inferred: a caller that reports "sandboxed" should be able to say what that covered.
      networkIsolated: unshareNet,
      ...(unshareNet ? {} : {
        note: 'this environment cannot create a network namespace (no CAP_NET_ADMIN), so the filesystem is sandboxed but the network is not',
      }),
    }
  }

  // macOS takes a profile file, not a profile string.
  const profile = sandboxExecProfile({ home })
  let path
  let cleanup
  try {
    if (typeof writeProfile === 'function') {
      path = writeProfile(profile)
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-health-sandbox-'))
      path = join(dir, 'profile.sb')
      writeFileSync(path, profile, 'utf8')
      cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
    }
  } catch (error) {
    return {
      ok: false,
      reason: `could not write the sandbox profile: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    ok: true,
    command: support.binary,
    args: ['-f', path, '--', command, ...args],
    ...(cleanup === undefined ? {} : { cleanup }),
  }
}

/**
 * Start the host inside a sandbox.
 *
 * Detached and unref'd like the unsandboxed launcher: the host has to keep running after this tool exits.
 * The profile file must outlive the spawn — sandbox-exec reads it at exec time — so cleanup is tied to
 * the child rather than happening immediately.
 *
 * @param {{home: string, command: string, args?: string[], platform?: string}} options
 * @returns {{ok: true, pid: number, kind: 'sandboxed'} | {ok: false, error: string}}
 */
export function launchSandboxed({ home, command, args = [], platform = process.platform }) {
  if (!existsSync(command)) return { ok: false, error: `no such executable: ${command}` }

  const built = buildSandboxedCommand({ platform, home, command, args })
  if (built.ok !== true) return { ok: false, error: built.reason }

  let child
  try {
    child = spawn(built.command, built.args, { detached: true, stdio: 'ignore' })
  } catch (error) {
    built.cleanup?.()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  let failed
  child.once('error', (error) => { failed = error })
  if (failed !== undefined) {
    built.cleanup?.()
    return { ok: false, error: String(failed.message ?? failed) }
  }

  if (built.cleanup !== undefined) {
    child.once('exit', () => built.cleanup())
    child.once('error', () => built.cleanup())
  }
  child.unref()
  return { ok: true, pid: child.pid ?? 0, kind: 'sandboxed' }
}

/**
 * A shell that exists on this machine, or undefined.
 * @param {string} [platform]
 */
export function findShell(platform = process.platform) {
  for (const candidate of SHELLS[platform] ?? []) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
