/** Opt-in runtime acceptance in a new, retained DSH home. */
import { spawn } from 'node:child_process'
import { nodeCommand } from '../util/node-exec.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

import { createRequire } from 'node:module'

import { environmentForRun } from './env.js'
import { classifyFailure } from './classify.js'
import { probePnpmVersion, readSubjects, runtimeEnvironment, toolIdentity } from './evidence.js'

/** Upper bound for any single stage, so a caller cannot ask for a week-long rehearsal. */
const MAX_TIMEOUT_MS = 10 * 60 * 1000

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url))
const LOG_LIMIT = 64 * 1024

/** Run without a shell; bound both execution and shutdown, including child processes. */
export function runBoundedProcess(args, { cwd, env, timeoutMs, killAfterMs = 1000 }) {
  return new Promise((resolveResult, reject) => {
    // Inside the desktop build this is Electron: the executable is the application, and without
    // ELECTRON_RUN_AS_NODE the child is a second window rather than the script.
    const node = nodeCommand({ env })
    const child = spawn(node.command, args, {
      cwd, env: node.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let orphaned = false
    let forceTimer
    let closeDeadline
    let cleanupUnconfirmed = false
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
        if (child.exitCode !== null || child.signalCode !== null) return
        // Node cannot signal a Windows process tree. taskkill also stops pnpm children.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        const fallback = () => {
          cleanupUnconfirmed = true
          try { child.kill('SIGKILL') } catch { /* process already exited or cannot be signalled */ }
        }
        killer.once('error', fallback)
        killer.once('exit', (code) => { if (code !== 0) fallback() })
        killer.unref()
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
        if (closed === undefined) {
          closeDeadline = setTimeout(() => {
            cleanupUnconfirmed = true
            closed = { exitCode: child.exitCode, signal: child.signalCode }
            child.stdout.destroy()
            child.stderr.destroy()
            child.unref()
            finish()
          }, 1000)
        }
      }, killAfterMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopTree()
    }, timeoutMs)
    const finish = () => {
      if (closed === undefined || ((timedOut || orphaned) && !forceComplete)) return
      clearTimeout(timer)
      clearTimeout(closeDeadline)
      resolveResult({ ok: !timedOut && !orphaned && closed.exitCode === 0, ...closed, timedOut, orphaned, stdout, stderr, truncated,
        ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      })
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      clearTimeout(closeDeadline)
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
 * Add official bundles that ship inside the host to a trial profile's bundle list.
 *
 * A profile created by `dsh plugin --profile x add` contains only `dsh-base` and the plugin. A real desktop or
 * web profile also has `@deepseek-ai/dsh-web-app`, which provides `webServer`, `connection`,
 * `workspaceRegistry` and more. Without it, 80 of the 250 most-used plugins on 2026-11-09 "did not start"
 * only because they were waiting for services every user has. The host resolves official bundles from its
 * own install directory, so nothing is installed here: the names are added to `dsh.profile.bundles`.
 *
 * Only `@deepseek-ai/dsh-*` names that the host actually carries are accepted.
 *
 * @param {string} profileDirectory
 * @param {string} hostDir - the installed `@deepseek-ai/dsh`.
 * @param {readonly string[]} names
 * @returns {string[]} the names that were added.
 */
export function addHostBundles(profileDirectory, hostDir, names = []) {
  if (names.length === 0) return []
  const requireHost = createRequire(join(hostDir, 'package.json'))
  for (const name of names) {
    if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/u.test(name)) throw new Error(`host bundles must be official @deepseek-ai/dsh-* packages: ${name}`)
    try { requireHost.resolve(`${name}/package.json`) } catch {
      throw new Error(`the host at ${hostDir} does not carry ${name}`)
    }
  }
  const manifestPath = join(profileDirectory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const added = names.filter((name) => !bundles.includes(name))
  manifest.dsh.profile.bundles = [...bundles, ...added]
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return added
}

/**
 * Resolve `{ name, version }` for a plugin spec.
 *
 * Three shapes reach here: a registry spec (`@scope/pkg@1.2.3`), a local directory to
 * pack, and a local tarball. Only the directory can be read directly; a tarball has to
 * be unpacked, so its identity comes from the database record npm writes next to it, or
 * from the caller passing `name@version` explicitly.
 * @param {string} spec
 * @param {{name?: string, version?: string}} [known] - identity supplied by the caller,
 *   which is the only way to identify a tarball without unpacking it.
 */
export function resolvePluginIdentity(spec, known = {}) {
  if (typeof known.name === 'string' && known.name !== '' && typeof known.version === 'string' && known.version !== '') {
    return { name: known.name, version: known.version }
  }
  if (existsSync(spec) && statSync(spec).isDirectory()) {
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
  if (existsSync(spec)) {
    // A tarball or any other single file: its identity is not readable from the path, and
    // guessing it from the filename would be wrong for scoped packages.
    throw new Error(
      `--bypass-gate cannot read the plugin identity from ${spec}; `
      + 'pass the plugin as name@version (for example @scope/pkg@1.2.3) so the exemption can name it exactly',
    )
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
 * then verify caller-selected tools. The orchestrator selects a new DSH_HOME for the trial;
 * executed code still has the current account's access to existing profiles and other resources.
 * The run directory and bounded logs remain available on success and failure.
 *
 * `bootOnly` accepts a run with no tool assertions. That is the only meaningful
 * check for plugins that register no model-facing tools (UI-only bundles): the
 * question there is whether every entry activates at all, which `verifyActivation`
 * in the worker answers. Tool assertions still run when supplied.
 *
 * `bypassGate` grants the official exact-version exemption *inside the temporary
 * test home only*, before installing. Without it an incompatible plugin is simply
 * rejected and the run tells us nothing about whether the code would have worked.
 * Health writes that trial exemption to the new home, not the selected normal profile.
 * Trial files are retained. None of this restricts plugin behavior or establishes a security boundary.
 */
export async function runRuntimeSmoke({
  dshDirectory, plugin, tools = [], calls = [], out, bootOnly = false, bypassGate = false,
  pluginName, pluginVersion, registryOnly = false, companions = [],
  timeoutMs = 30_000, installTimeoutMs = 120_000,
  // Default false keeps the documented behaviour of rehearsing your own plugin. Anything running plugins the
  // operator has not read — a batch run, CI over a catalog — should pass true.
  cleanEnv = false,
  // Official bundles from the host's own install to add to the profile, so the trial looks like a real one.
  hostBundles = [],
}, { runProcess: launch = runBoundedProcess, probePnpm = probePnpmVersion } = {}) {
  // Every stage records when it started and how long it took. Without durations a timeout cannot be told
  // apart from a slow registry, and a cached rerun cannot be compared with the first one.
  const runProcess = async (args, settings) => {
    const startedAt = new Date()
    const result = await launch(args, settings)
    return { startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), ...result }
  }
  // A registry-only run must be told the identity: there is no path to read it from, and the spec
  // came from a request rather than from a human.
  if (registryOnly && (typeof pluginName !== 'string' || pluginName === '')) {
    throw new Error('a registry-only smoke run needs the plugin name; the spec is not a path')
  }
  if (typeof dshDirectory !== 'string' || typeof plugin !== 'string' || plugin === '' || plugin.startsWith('-')) {
    throw new Error('smoke requires --dsh-dir <installed @deepseek-ai/dsh directory> and --plugin <spec|tarball>')
  }
  if (!Array.isArray(companions) || companions.length > 12 ||
      companions.some(spec => typeof spec !== 'string' || !spec || spec.startsWith('-')) ||
      (companions.length > 0 && registryOnly)) {
    throw new Error('supply up to 12 companion plugins in a local smoke run')
  }
  // A huge timeout is not a harmless request: Node clamps delays above 2^31-1 and fires almost
  // immediately, while a value just below that leaves a rehearsal running for weeks. Cap both ends.
  for (const timeout of [timeoutMs, installTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('smoke timeouts must be positive numbers')
    if (timeout > MAX_TIMEOUT_MS) throw new Error(`smoke timeouts must not exceed ${MAX_TIMEOUT_MS}ms (10 minutes)`)
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
  // A spec from a request must never be interpreted as a path: `existsSync` is relative to the
  // host's cwd, so a directory there named like `foo@1.0.0` would decide what gets installed.
  const pluginSpec = registryOnly || !existsSync(plugin) ? plugin : resolve(plugin)
  // `allow-version` needs the exact `name@version` pair the gate rejected. Only resolve it
  // when we are actually going to grant the exemption: a plain smoke run must not fail
  // just because a tarball's identity cannot be read from its path.
  const resolved = bypassGate
    ? resolvePluginIdentity(pluginSpec, { name: pluginName, version: pluginVersion })
    : { name: undefined, version: undefined }
  const resolvedName = resolved.name
  const resolvedVersion = resolved.version
  const combination = companions.length === 0 ? null : [pluginSpec, ...companions].map(spec => {
    const input = existsSync(spec) ? resolve(spec) : spec
    const identity = resolvePluginIdentity(input)
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(identity.name) ||
        !semver.valid(identity.version)) throw new Error('combination inputs need exact package versions or unpacked package directories')
    return { spec: input, ...identity }
  })
  if (combination && new Set(combination.map(row => row.name)).size !== combination.length) {
    throw new Error('a combination must use distinct package names')
  }
  const parent = out === undefined ? tmpdir() : resolve(out)
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'dsh-health-smoke-'))
  const home = join(directory, 'home')
  const profile = 'health-smoke'
  const reportPath = join(directory, 'smoke.json')
  const workerResult = join(directory, 'runtime.json')
  const configPath = join(directory, 'config.json')
  const { env, report: envReport } = environmentForRun({ clean: cleanEnv, home })
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    hostVersion: manifest.version, plugin: pluginSpec, directory, home, profile,
    ok: false, stages: [],
    tool: toolIdentity(),
    runtimeEnv: runtimeEnvironment({ pnpm: await probePnpm({ env }) }),
    subjects: [],
    // Names only. A report is meant to be shareable, and a value here would be a token in a gist.
    env: envReport,
    ...(combination ? { combination } : {}),
  }
  const save = () => { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`) }
  // What was actually installed, read back from the profile pnpm wrote. Missing evidence is recorded as
  // missing; it never decides the outcome.
  const recordSubjects = () => {
    const names = combination?.map(row => row.name) ?? (resolvedName ? [resolvedName] : undefined)
    try {
      report.subjects = readSubjects(join(home, 'profiles', profile), names)
    } catch (error) {
      report.subjects = [{ name: resolvedName ?? pluginSpec, version: null, integrity: null, resolution: null, evidenceError: error.message }]
    }
    save()
  }
  // A failed run says why, in a word a page can translate. Appended only when the run failed.
  const finish = () => {
    if (!report.ok) report.failure = classifyFailure(report)
    save()
    return report
  }
  save()
  try {
    if (bypassGate) {
      // The host's own gate rejected this exact-version pair; grant the exemption it asks
      // for inside the temporary DSH home so the install can proceed and the boot can be judged.
      const granted = await runProcess([
        resolve(hostDir, bin), 'plugin', '--profile', profile, 'allow-version',
        `${resolvedName}@${resolvedVersion}`, '--dsh-version', manifest.version, '--accept-risk',
      ], { cwd: directory, env, timeoutMs: installTimeoutMs })
      report.stages.push({ name: 'allow-version', ...granted })
      save()
      if (!granted.ok) return finish()
    }
    for (const subject of combination ?? [{ spec: pluginSpec }]) {
      const installed = await runProcess([resolve(hostDir, bin), 'plugin', '--profile', profile, 'add', subject.spec], {
        cwd: directory, env, timeoutMs: installTimeoutMs,
      })
      report.stages.push({ name: 'install', ...installed, ...(combination ? { plugin: subject.name } : {}) })
      save()
      if (!installed.ok) {
        recordSubjects()
        return finish()
      }
    }
    if (hostBundles.length > 0) report.hostBundles = addHostBundles(join(home, 'profiles', profile), hostDir, hostBundles)
    recordSubjects()
    writeFileSync(configPath, JSON.stringify({
      hostDir, profile, tools, calls, resultPath: workerResult,
      webApp: hostBundles.includes('@deepseek-ai/dsh-web-app'),
      plugin: resolvedName,
      plugins: combination?.map(row => row.name),
    }))
    // No --expose-internals: it gave the plugin under test Node's internal bindings, made any probe in
    // this worker bypassable, and made the rehearsal differ from the real host. Verified unnecessary.
    const runtime = await runProcess([WORKER, configPath], { cwd: directory, env, timeoutMs })
    const stage = { name: 'runtime', ...runtime, ok: false }
    report.stages.push(stage)
    if (existsSync(workerResult)) {
      try { stage.details = JSON.parse(readFileSync(workerResult, 'utf8')) } catch (error) {
        stage.error = `could not read runtime report: ${error.message}`
      }
    } else stage.error = 'worker exited without a runtime report'
    stage.ok = runtime.ok && stage.details?.ok === true
    if (typeof stage.details?.hostCordis === 'string') report.runtimeEnv.cordis = stage.details.hostCordis
    report.ok = stage.ok
    save()
    return finish()
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    save()
    return finish()
  }
}

/**
 * Boot a profile with no third-party plugin, to learn what the host itself occupies.
 *
 * A plugin's footprint only means something relative to this: the host registers dozens of entries and tools
 * on its own, and a plugin "registering web_search" is noise if the host already did. `plugin list` is the
 * cheapest official command that initializes a profile without installing anything into it.
 *
 * The verdict is the footprint, not `ok`: an empty profile has nothing under test, so the worker's own
 * completion state is recorded but not required.
 *
 * @returns {Promise<{hostVersion: string, directory: string, footprint: object|null, hostContract?: object, error?: string}>}
 */
export async function runHostBaseline({ dshDirectory, out, timeoutMs = 60_000, installTimeoutMs = 120_000, hostBundles = [] }, { runProcess = runBoundedProcess } = {}) {
  const hostDir = resolve(dshDirectory)
  const manifest = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error('--dsh-dir must contain @deepseek-ai/dsh/package.json')
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  const parent = out === undefined ? tmpdir() : resolve(out)
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'dsh-health-baseline-'))
  const home = join(directory, 'home')
  const profile = 'health-smoke'
  const configPath = join(directory, 'config.json')
  const resultPath = join(directory, 'runtime.json')
  const { env } = environmentForRun({ clean: true, home })
  const baseline = { hostVersion: manifest.version, directory, footprint: null }
  const initialized = await runProcess([resolve(hostDir, bin), 'plugin', '--profile', profile, 'list'], { cwd: directory, env, timeoutMs: installTimeoutMs })
  if (!initialized.ok) {
    baseline.error = `could not initialize an empty profile: ${(initialized.stderr || initialized.stdout || '').trim().slice(-500)}`
    return baseline
  }
  // The baseline must have the same host bundles as every trial, or their entries would count as the plugin's.
  if (hostBundles.length > 0) baseline.hostBundles = addHostBundles(join(home, 'profiles', profile), hostDir, hostBundles)
  writeFileSync(configPath, JSON.stringify({ hostDir, profile, tools: [], calls: [], resultPath, webApp: hostBundles.includes('@deepseek-ai/dsh-web-app') }))
  await runProcess([WORKER, configPath], { cwd: directory, env, timeoutMs })
  try {
    const runtime = JSON.parse(readFileSync(resultPath, 'utf8'))
    baseline.footprint = runtime.footprint ?? null
    if (runtime.hostContract) baseline.hostContract = runtime.hostContract
    if (!baseline.footprint) baseline.error = runtime.error ?? 'the empty profile did not boot far enough to record a footprint'
  } catch (error) {
    baseline.error = `no baseline runtime report: ${error.message}`
  }
  writeFileSync(join(directory, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`)
  return baseline
}
