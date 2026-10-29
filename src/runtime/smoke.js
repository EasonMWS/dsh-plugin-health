/** Opt-in runtime acceptance in a new, retained DSH home. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url))
const LOG_LIMIT = 64 * 1024

/** Run without a shell; bound both execution and shutdown, including child processes. */
export function runBoundedProcess(args, { cwd, env, timeoutMs, killAfterMs = 1000 }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let orphaned = false
    let forceTimer
    let forceComplete = false
    let closed
    const append = (current, chunk) => {
      const next = current + chunk.toString()
      if (next.length > LOG_LIMIT) truncated = true
      return next.slice(-LOG_LIMIT)
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const kill = (signal) => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        // Node cannot signal a Windows process tree. taskkill also stops pnpm children.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        killer.on('error', () => { child.kill('SIGKILL') })
      } else {
        try { process.kill(-child.pid, signal) } catch (error) {
          if (error.code !== 'ESRCH') child.kill(signal)
        }
      }
    }
    const stopTree = () => {
      kill('SIGTERM')
      forceTimer = setTimeout(() => {
        kill('SIGKILL')
        forceComplete = true
        finish()
      }, killAfterMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopTree()
    }, timeoutMs)
    const finish = () => {
      if (closed === undefined || ((timedOut || orphaned) && !forceComplete)) return
      clearTimeout(timer)
      resolveResult({ ok: !timedOut && !orphaned && closed.exitCode === 0, ...closed, timedOut, orphaned, stdout, stderr, truncated })
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      closed = { exitCode, signal }
      if (!timedOut && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 0)
          // A parent can exit zero while its unref'ed, stdio-less children survive.
          orphaned = true
          stopTree()
        } catch (error) {
          if (error.code !== 'ESRCH') {
            orphaned = true
            stopTree()
          }
        }
      }
      finish()
    })
  })
}

/**
 * Resolve `{ name, version }` for a plugin spec: a local directory/tarball is read from
 * its manifest, a registry spec is split on the last `@` that is not the scope separator.
 * Throws with a readable message when the identity cannot be established, because
 * `allow-version` cannot be granted blindly.
 */
export function resolvePluginIdentity(spec) {
  if (existsSync(spec)) {
    const manifestPath = join(resolve(spec), 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`--bypass-gate needs a package.json to read the plugin identity from: ${manifestPath}`)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`--bypass-gate needs name and version in ${manifestPath}`)
    }
    return { name: manifest.name, version: manifest.version }
  }
  const at = spec.lastIndexOf('@')
  if (at <= 0) {
    throw new Error('--bypass-gate needs an exact name@version spec; a bare package name has no version to exempt')
  }
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  if (!name || !version || version.includes('/')) {
    throw new Error('--bypass-gate needs an exact name@version spec, for example @scope/pkg@1.2.3')
  }
  return { name, version }
}

/**
 * Install through the official CLI, boot through its public profile-boot export,
 * then verify caller-selected tools. No existing profile is read or modified.
 * The run directory and bounded logs remain available on success and failure.
 *
 * `bootOnly` accepts a run with no tool assertions. That is the only meaningful
 * check for plugins that register no model-facing tools (UI-only bundles): the
 * question there is whether every entry activates at all, which `verifyActivation`
 * in the worker answers. Tool assertions still run when supplied.
 *
 * `bypassGate` grants the official exact-version exemption *inside the throwaway
 * test home only*, before installing. Without it an incompatible plugin is simply
 * rejected and the run tells us nothing about whether the code would have worked.
 * The exemption is never written to a real profile: the home is deleted with the
 * run directory's parent policy, and this is what separates "the gate says no"
 * from "the plugin actually breaks".
 */
export async function runRuntimeSmoke({
  dshDirectory, plugin, tools = [], calls = [], out, bootOnly = false, bypassGate = false,
  timeoutMs = 30_000, installTimeoutMs = 120_000,
}, { runProcess = runBoundedProcess } = {}) {
  if (typeof dshDirectory !== 'string' || typeof plugin !== 'string' || plugin === '' || plugin.startsWith('-')) {
    throw new Error('smoke requires --dsh-dir <installed @deepseek-ai/dsh directory> and --plugin <spec|tarball>')
  }
  for (const timeout of [timeoutMs, installTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('smoke timeouts must be positive numbers')
  }
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || tool === '')) throw new Error('tools must be non-empty names')
  if (!Array.isArray(calls) || calls.some(call => typeof call?.name !== 'string' || call.name === '' || call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments))) {
    throw new Error('calls must be an array of { name, arguments, expectedValue? } objects')
  }
  if (tools.length === 0 && calls.length === 0 && bootOnly !== true) {
    throw new Error('smoke requires at least one --tool or --calls assertion, or --boot-only')
  }
  const hostDir = resolve(dshDirectory)
  const manifest = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error('--dsh-dir must contain @deepseek-ai/dsh/package.json')
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string') throw new Error('the installed DSH package declares no dsh executable')
  const pluginSpec = existsSync(plugin) ? resolve(plugin) : plugin
  // `allow-version` needs the exact `name@version` pair the gate rejected, so resolve it
  // from the installed manifest for tarballs/directories and from the spec for registry names.
  const resolved = resolvePluginIdentity(pluginSpec)
  const pluginName = resolved.name
  const installedVersion = resolved.version
  const parent = out === undefined ? tmpdir() : resolve(out)
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'dsh-health-smoke-'))
  const home = join(directory, 'home')
  const profile = 'health-smoke'
  const reportPath = join(directory, 'smoke.json')
  const workerResult = join(directory, 'runtime.json')
  const configPath = join(directory, 'config.json')
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    hostVersion: manifest.version, plugin: pluginSpec, directory, home, profile,
    ok: false, stages: [],
  }
  const save = () => { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`) }
  save()
  try {
    if (bypassGate) {
      // The host's own gate rejected this exact-version pair; grant the exemption it asks
      // for inside the isolated home so the install can proceed and the boot can be judged.
      const granted = await runProcess([
        resolve(hostDir, bin), 'plugin', '--profile', profile, 'allow-version',
        `${pluginName}@${installedVersion}`, '--dsh-version', manifest.version, '--accept-risk',
      ], { cwd: directory, env, timeoutMs: installTimeoutMs })
      report.stages.push({ name: 'allow-version', ...granted })
      save()
      if (!granted.ok) return report
    }
    const installed = await runProcess([resolve(hostDir, bin), 'plugin', '--profile', profile, 'add', pluginSpec], {
      cwd: directory, env, timeoutMs: installTimeoutMs,
    })
    report.stages.push({ name: 'install', ...installed })
    save()
    if (!installed.ok) return report
    writeFileSync(configPath, JSON.stringify({ hostDir, profile, tools, calls, resultPath: workerResult }))
    const runtime = await runProcess(['--expose-internals', WORKER, configPath], { cwd: directory, env, timeoutMs })
    const stage = { name: 'runtime', ...runtime, ok: false }
    report.stages.push(stage)
    if (existsSync(workerResult)) {
      try { stage.details = JSON.parse(readFileSync(workerResult, 'utf8')) } catch (error) {
        stage.error = `could not read runtime report: ${error.message}`
      }
    } else stage.error = 'worker exited without a runtime report'
    stage.ok = runtime.ok && stage.details?.ok === true
    report.ok = stage.ok
    save()
    return report
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    save()
    return report
  }
}
