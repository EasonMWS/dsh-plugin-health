/**
 * Installing an update of this plugin, from inside itself.
 *
 * This is the most dangerous thing the package does. Everything else it writes is a reversible entry
 * in a file it owns; this replaces the running plugin's own files in a profile DSH is booting from.
 * A failed install leaves the panel broken and, in the worst case, DSH unable to start.
 *
 * So the design is deliberately conservative:
 *
 * 1. **The package manager is the profile's own.** The profile here is a pnpm workspace
 *    (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/.pnpm`), and installing with npm into it
 *    would produce a tree neither tool can reconcile. The manager is detected, not assumed.
 * 2. **Non-interactive, or not at all.** pnpm prompts about supply-chain policy and about new
 *    releases younger than `minimumReleaseAge`. A prompt in a background process is a hang, so every
 *    invocation passes the flags that turn prompts into decisions, and the timeout is finite.
 * 3. **One at a time.** A second click while an install runs must not start a second pnpm against the
 *    same directory.
 * 4. **Restart is the user's call.** The files change on disk; the running host keeps the code it
 *    loaded. Telling the user to restart is honest; restarting for them would end their session.
 * @module ui/install
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { unmetRequirements } from '../compat/evaluate.js'
import { nodeCommand } from '../util/node-exec.js'
import { CURRENT_VERSION, compareVersions } from './update.js'

/** The package this module upgrades. */
const PACKAGE = 'dsh-plugin-health'

/** How long a package install may take before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 300_000

/**
 * @typedef {object} InstallState
 * @property {'idle'|'installing'|'done'|'failed'} phase
 * @property {string|null} targetVersion the version being installed
 * @property {string|null} previousVersion what was installed when the install started
 * @property {string|null} restartRequiredFrom version now on disk, when it differs from what is running
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} error
 * @property {string[]} log last lines of package-manager output, for when it fails
 */

/** @type {InstallState} */
let state = {
  phase: 'idle',
  targetVersion: null,
  previousVersion: null,
  restartRequiredFrom: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  log: [],
}

/** @type {Promise<InstallState>|undefined} */
let inFlight

/**
 * Which package manager owns this profile.
 *
 * Guessing wrong is worse than failing: `npm install` into a pnpm workspace rewrites
 * `node_modules` into a shape pnpm cannot read, and the next `dsh plugin add` then fails for a reason
 * that has nothing to do with the plugin the user was installing.
 * @param {string} profileDir
 * @returns {'pnpm'|'npm'}
 */
export function detectPackageManager(profileDir) {
  // pnpm's own markers. A lockfile without .pnpm is a half-migrated profile; the directory is the
  // signal that matters, because it holds the real files.
  if (existsSync(join(profileDir, 'pnpm-lock.yaml')) || existsSync(join(profileDir, 'node_modules', '.pnpm'))) {
    return 'pnpm'
  }
  return 'npm'
}

/**
 * How to launch npm or pnpm without a shell.
 *
 * On Windows both are `.cmd` shims, and since the CVE-2024-27980 fix Node refuses to spawn those
 * without `shell: true`. Running the JavaScript entry point with the current Node binary sidesteps the
 * shim and keeps the no-shell rule, which matters because a package manager command line is built
 * from a version string.
 * @param {'pnpm'|'npm'} manager
 * @param {string[]} args
 * @param {{execPath?: string}} [options]
 * @returns {{command: string, args: string[]}}
 */
export function managerInvocation(manager, args, { execPath = nodeCommand().command } = {}) {
  if (manager !== 'npm' && manager !== 'pnpm') throw new Error('unsupported package manager')
  if (process.platform !== 'win32') return { command: manager, args }
  const prefix = dirname(execPath)
  // A bundled native executable is the cleanest option on Windows: no shim, no shell, and nothing to
  // escape. pnpm ships one; npm does not.
  if (manager === 'pnpm') {
    const native = join(prefix, 'node_modules', 'pnpm', 'pnpm.exe')
    if (existsSync(native)) return { command: native, args }
    const esm = join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
    if (existsSync(esm)) return { command: execPath, args: [esm, ...args] }
  }
  // npm's JavaScript entry point, which has kept this name for years.
  const npmCli = join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (manager === 'npm' && existsSync(npmCli)) return { command: execPath, args: [npmCli, ...args] }
  // Last resort: the .cmd shim, which needs a shell. The arguments are a fixed list plus a version
  // this module validated against the registry, so there is nothing user-controlled to escape.
  return { command: `${manager}.cmd`, args, shell: true }
}

/**
 * The version actually present in the profile, read from disk.
 * @param {string} profileDir
 * @returns {string|undefined}
 */
export function installedVersion(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', PACKAGE, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Keep only printable lines, so package-manager colour codes and progress bars do not end up in a
 * JSON response.
 * @param {string} text
 * @returns {string[]}
 */
function usefulLines(text) {
  return String(text)
    .split(/\r?\n/u)
    .map((line) => line.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, '').trim())
    .filter((line) => line !== '' && !/^(Progress|Downloading|Resolving|Reusing)\b/iu.test(line))
    .slice(-12)
}

/**
 * Run one package-manager command to completion.
 * @param {{manager: 'pnpm'|'npm', args: string[], cwd: string, timeoutMs: number, runProcess?: Function}} options
 * @returns {Promise<{ok: boolean, code: number|null, output: string, timedOut: boolean}>}
 */
function runManager({ manager, args, cwd, timeoutMs, runProcess }) {
  if (runProcess !== undefined) return runProcess({ manager, args, cwd, timeoutMs })
  return new Promise((resolveResult) => {
    const invocation = managerInvocation(manager, args)
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: invocation.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // pnpm reads these to decide whether it is allowed to prompt. In a process nobody is watching,
      // a prompt is a hang; these make it choose.
      env: { ...process.env, CI: '1', npm_config_yes: 'true', ADBLOCK: '1', NO_UPDATE_NOTIFIER: '1' },
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // On Windows the package manager runs through a shell, so child.kill() ends the shell and
      // leaves the real work orphaned — still installing, and no longer tracked by the in-flight
      // guard. taskkill /T stops the tree. Same approach as runtime/smoke.js.
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          killer.on('error', () => { try { child.kill() } catch { /* already gone */ } })
        } catch { try { child.kill() } catch { /* already gone */ } }
      } else {
        try { child.kill() } catch { /* already gone */ }
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({ ok: false, code: null, output: `${output}\n${String(error)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveResult({ ok: code === 0 && !timedOut, code, output, timedOut })
    })
  })
}

/**
 * Install a specific version of this package into a profile.
 *
 * Never throws: every outcome is a state the panel can render. The caller decides what to say.
 * @param {{
 *   profileDir: string, version: string, currentVersion?: string,
 *   manager?: 'pnpm'|'npm', timeoutMs?: number, runProcess?: Function,
 * }} options
 * @returns {Promise<InstallState>}
 */
export async function installUpdate({
  profileDir,
  version,
  currentVersion = CURRENT_VERSION,
  runtimeVersion,
  manager,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runProcess,
} = {}) {
  if (typeof profileDir !== 'string' || profileDir === '') {
    return { ...state, phase: 'failed', error: 'no profile to install into' }
  }
  // A version is pasted into a command line, so it is validated rather than trusted. The registry is
  // the source, but this module can also be driven directly.
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    return { ...state, phase: 'failed', error: `not a version: ${String(version)}` }
  }
  if (inFlight !== undefined) return inFlight
  // Never move backwards. This action exists to pick up a released fix; a downgrade would undo one
  // and could land on a build whose engines.dsh excludes the running host, leaving the plugin unable
  // to load after the restart — the exact failure this package exists to prevent.
  if (typeof currentVersion === 'string' && currentVersion !== '' && compareVersions(currentVersion, version) > 0) {
    return { ...state, phase: 'failed', error: `refusing to downgrade from ${currentVersion} to ${version}` }
  }

  const kind = manager ?? detectPackageManager(profileDir)
  if (kind !== 'npm' && kind !== 'pnpm') return { ...state, phase: 'failed', error: 'unsupported package manager' }
  const previousVersion = installedVersion(profileDir) ?? currentVersion ?? null
  const startedAt = new Date().toISOString()
  state = {
    phase: 'installing',
    targetVersion: version,
    previousVersion,
    restartRequiredFrom: null,
    startedAt,
    finishedAt: null,
    error: null,
    log: [],
  }

  // `add <pkg>@<version>` rather than `update`: it is explicit about the target, it updates the
  // profile's package.json, and it does not resolve a range the profile may have pinned elsewhere.
  // Preserve the profile's release-age policy. Updating this package must not run lifecycle scripts
  // from the profile or dependencies; this package ships its runtime directly and needs no build.
  const args = kind === 'pnpm'
    ? ['add', `${PACKAGE}@${version}`, '--ignore-scripts', '--reporter=append-only', '--yes']
    : ['install', `${PACKAGE}@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress']

  inFlight = (async () => {
    try {
      const result = await runManager({ manager: kind, args, cwd: profileDir, timeoutMs, runProcess })
      const onDisk = installedVersion(profileDir)
      if (!result.ok) {
        state = {
          ...state,
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          error: result.timedOut
            ? `the package manager did not finish within ${Math.round(timeoutMs / 1000)}s`
            : `the package manager exited with code ${result.code ?? 'unknown'}`,
          log: usefulLines(result.output),
        }
        return state
      }
      // The command succeeded; whether the files changed is a separate question, and the only answer
      // that counts is the one on disk.
      if (onDisk !== version) {
        state = {
          ...state,
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          error: onDisk === undefined
            ? 'the package manager reported success but the plugin is not in the profile'
            : `the package manager reported success but ${onDisk} is on disk, not ${version}`,
          log: usefulLines(result.output),
        }
        return state
      }
      // The files are now the target version. Ask that version's own manifest whether it will load
      // on the running host: a successful install that cannot boot is the worst possible outcome for
      // a tool whose job is keeping DSH bootable.
      let bootWarning
      try {
        const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', PACKAGE, 'package.json'), 'utf8'))
        // Without a host version there is nothing to compare against. Treating "unknown" as
        // "incompatible" would warn on every install a caller made without passing one.
        const unmet = typeof runtimeVersion === 'string' && runtimeVersion !== ''
          ? unmetRequirements(manifest, runtimeVersion)
          : {}
        if (Object.keys(unmet).length > 0) {
          bootWarning = `${version} declares ${JSON.stringify(unmet)}, which excludes the running host ${runtimeVersion}`
        }
      } catch { /* a missing manifest is handled above by the on-disk check */ }
      state = {
        ...state,
        phase: 'done',
        bootWarning,
        finishedAt: new Date().toISOString(),
        // The running host still has the previous code loaded, so the panel has to say so rather than
        // pretend the new version is live.
        restartRequiredFrom: previousVersion === undefined ? null : previousVersion,
        log: usefulLines(result.output),
      }
      return state
    } finally {
      inFlight = undefined
    }
  })()

  return inFlight
}

/**
 * The current install state, without touching anything.
 * @returns {InstallState}
 */
export function installSnapshot() {
  return { ...state, log: [...state.log] }
}

/** Reset module state. Tests only. */
export function resetInstallStateForTests() {
  state = {
    phase: 'idle',
    targetVersion: null,
    previousVersion: null,
    restartRequiredFrom: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    log: [],
  }
  inFlight = undefined
}
