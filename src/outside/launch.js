/**
 * Start DSH after an admission check has passed.
 *
 * Two rules govern this module:
 *
 *   1. The admission result is written to the shared state before the host starts, so the panel inside
 *      DSH can see that this launch was checked and against what. A check nobody can find afterwards
 *      is not a check.
 *   2. A blocking verdict does not silently start anyway. Starting is the caller's decision, and it has
 *      to be an explicit one.
 *
 * This does not try to sandbox the host. Without an OS-level container that is not possible from here,
 * and pretending otherwise would be the worst kind of safety feature.
 * @module outside/launch
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { admissionReport } from './admission.js'
import { updateState } from '../state/shared.js'

/**
 * Record an admission result in the shared state.
 *
 * @param {string} home
 * @param {object} report
 * @returns {{ok: true, rev: number} | {ok: false, error: string}}
 */
export function recordAdmission(home, report) {
  const result = updateState(home, (current) => ({ ...current, admission: report }), { writer: 'outside' })
  if (result.ok !== true) return { ok: false, error: result.error }
  return { ok: true, rev: result.state.rev }
}

/**
 * How the host is started on this machine.
 *
 * The desktop app is an installed application, not a node script, so spawning it works differently from
 * a CLI install. Both are supported; neither is assumed to exist.
 *
 * @param {{home: string, execPath?: string}} options
 * @returns {{command: string, args: string[], kind: 'desktop'|'cli'} | {error: string}}
 */
export function resolveLauncher({ home, execPath = process.execPath }) {
  // A desktop install ships its own binary. The tool cannot guess its location on every platform, so it
  // looks only where the current platform actually puts it, and reports when it finds nothing rather
  // than starting the wrong thing.
  const env = process.env
  const desktopCandidates = process.platform === 'win32'
    ? [
        join(env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness']
      : [join(env.HOME ?? '', '.local', 'bin', 'deepseek-harness')]

  for (const candidate of desktopCandidates) {
    if (candidate !== '' && existsSync(candidate)) {
      return { command: candidate, args: [], kind: 'desktop' }
    }
  }

  // A CLI install: the profile has the host package, and node can run its entry point.
  const cliEntry = join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.js')
  if (existsSync(cliEntry)) {
    return { command: execPath, args: [cliEntry], kind: 'cli' }
  }

  return { error: '找不到 DSH 的可执行文件。桌面版请从开始菜单启动，或安装 npm 包 @deepseek-ai/dsh。' }
}

/**
 * Start the host.
 *
 * Detached and unref'd: this tool's server is not the host's parent in any meaningful sense, and the
 * host must keep running when the tool is closed.
 *
 * @param {{home: string, profile: string, onOutput?: (chunk: string) => void}} options
 * @returns {{ok: true, pid: number, kind: string} | {ok: false, error: string}}
 */
export function launchHost({ home, profile, onOutput }) {
  const launcher = resolveLauncher({ home })
  if (launcher.error !== undefined) return { ok: false, error: launcher.error }

  const args = launcher.kind === 'cli' ? [...launcher.args, '--profile', profile] : launcher.args
  let child
  try {
    child = spawn(launcher.command, args, {
      detached: true,
      stdio: onOutput === undefined ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
  } catch (error) {
    return { ok: false, error: `启动失败: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (onOutput !== undefined) {
    child.stdout?.on('data', (chunk) => onOutput(String(chunk)))
    child.stderr?.on('data', (chunk) => onOutput(String(chunk)))
  }

  // An immediate failure (bad path, permission) surfaces as an 'error' event, not a throw.
  let failed
  child.once('error', (error) => { failed = error })
  if (failed !== undefined) return { ok: false, error: String(failed.message ?? failed) }

  child.unref()
  return { ok: true, pid: child.pid ?? 0, kind: launcher.kind }
}

/**
 * Check the profile, record the result, and start the host only if that is what was asked for.
 *
 * @param {{home: string, profile: string, runtimeVersion?: string, targetVersion?: string, start: boolean}} options
 * @returns {object}
 */
export function checkAndLaunch({ home, profile, runtimeVersion, targetVersion, start }) {
  const report = admissionReport({ home, profile, runtimeVersion, targetVersion })
  const recorded = recordAdmission(home, report)

  if (report.verdict === 'block' && start !== true) {
    return {
      report,
      recorded,
      launched: false,
      stopped: 'admission said this profile would not start cleanly; pass start to launch anyway',
    }
  }
  if (start !== true) return { report, recorded, launched: false, stopped: 'not asked to start' }

  const launched = launchHost({ home, profile })
  return { report, recorded, launched: launched.ok === true, ...(launched.ok === true ? { pid: launched.pid, kind: launched.kind } : { error: launched.error }) }
}
