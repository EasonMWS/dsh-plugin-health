/**
 * Environment discovery for the rescue commands.
 *
 * A rescue needs two facts that the rest of the tool never needed: which DSH host
 * version is actually running, and where an installed `@deepseek-ai/dsh` package
 * lives (the rehearsal installs and boots through that copy).
 *
 * Both are discovered rather than guessed, and both are optional: when neither can
 * be found the rescue path degrades to "we cannot rehearse" instead of writing an
 * exemption we could not verify.
 * @module rescue/environment
 */
import { spawn } from 'node:child_process'
import { nodeCommand } from '../util/node-exec.js'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import semver from 'semver'

/**
 * Read the running host version for a profile. DSH records the resolved host
 * version in the profile lockfile; the desktop app also reports it through the
 * profile manifest. Falls back to the version of a `@deepseek-ai/dsh` dependency
 * when either record is missing.
 * @param {string} profileDir
 * @param {string} home
 * @returns {string|undefined}
 */
export function hostVersionOf(profileDir, home) {
  const candidates = [
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const path of candidates) {
    try {
      const version = JSON.parse(readFileSync(path, 'utf8')).version
      if (typeof version === 'string' && version !== '') return version
    } catch {
      // Try the next place the host may be installed.
    }
  }
  // The lockfile records the resolved version even when the package is hoisted elsewhere.
  try {
    const lock = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const match = lock.match(/@deepseek-ai\/dsh@([\w.+-]+)/u)
    if (match) return match[1]
  } catch {
    // No lockfile: fall through to undefined so callers can ask for --runtime.
  }
  return undefined
}

/**
 * Where this tool keeps a host package it downloaded for rehearsals.
 *
 * The desktop app bundles `@deepseek-ai/dsh` inside `app.asar`, so a normal desktop install
 * has no on-disk host package to boot. Rather than making that a dead end, the rehearsal
 * fetches its own copy once and reuses it — the copy is only ever used inside a throwaway
 * home, never to run the user's profile.
 * @param {string} home
 * @param {string} [version] - exact host version. When given, the cache lives in a per-version
 *   directory so a rehearsal can never boot a host other than the one it is proving.
 */
export function rehearsalHostRoot(home, version) {
  const base = join(home, '.plugin-health', 'host')
  return version === undefined ? base : join(base, version)
}

/**
 * Does this directory hold the exact host version we are about to rehearse against?
 * @param {string} directory
 * @param {string} version
 * @returns {boolean}
 */
function cacheMatches(directory, version) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return manifest?.version === version
  } catch {
    return false
  }
}

/**
 * Find an installed `@deepseek-ai/dsh` package that the rehearsal can boot through.
 *
 * When `version` is supplied, a candidate whose manifest reports a different version is skipped.
 * That check is the difference between "we rehearsed this plugin" and "we rehearsed a plugin on
 * some host we happened to have lying around": the exemption is written for the running version,
 * so booting anything else proves nothing about it.
 * @param {string} home
 * @param {string} profileDir
 * @param {string} [version] - exact host version the rehearsal is meant to prove.
 * @returns {string|undefined}
 */
export function discoverDshDirectory(home, profileDir, version) {
  const candidates = [
    // A copy this tool prepared earlier, so later runs do not download again.
    ...(version === undefined ? [rehearsalHostRoot(home)] : [rehearsalHostRoot(home, version), rehearsalHostRoot(home)])
      .map((root) => join(root, 'node_modules', '@deepseek-ai', 'dsh')),
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh'),
    join(home, 'node_modules', '@deepseek-ai', 'dsh'),
    // A plain `npm install @deepseek-ai/dsh` in a scratch dir is the documented way
    // to rehearse a host version that is not the one currently in use.
    join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, 'package.json'))) continue
    if (version !== undefined && !cacheMatches(candidate, version)) continue
    return candidate
  }
  return undefined
}

/**
 * The only shapes a host version may take.
 *
 * Two holes lived here. `version` was interpolated into an argument passed to a shell
 * (`shell: true` on Windows), so `0.2.1; calc.exe` was a command injection; and nothing stopped a
 * non-semver spec, so `npm:evil` installed an arbitrary package that was then `require`d and run.
 *
 * An exact version is now required. A dist-tag, a `npm:` alias, a `git+` URL or a `file:` path is
 * refused rather than sanitised — a host rehearsal has no legitimate reason to pull from anywhere
 * but the registry.
 * @param {string} version
 * @returns {string} the exact version
 */
export function requireHostVersion(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('a host rehearsal needs an exact version, not a dist-tag')
  }
  const text = version.trim()
  if (semver.valid(text) === null) {
    throw new Error(`refusing to install a host from ${JSON.stringify(version)}: an exact version is required`)
  }
  return text
}

/**
 * Install a host package for rehearsals when none is available.
 *
 * Only ever writes under `<home>/.plugin-health/host`, and only when the caller asked for a
 * rehearsal: a plain scan never triggers a download. The version matches what the profile
 * runs, because rehearsing against a different host would answer a different question.
 *
 * The install runs without a shell, with lifecycle scripts disabled, and against a fixed package
 * name with a validated version — so neither the command line nor the package identity can be
 * steered by a caller-supplied string.
 * @param {object} options
 * @param {string} options.home
 * @param {string} options.version - exact host version to install
 * @param {Function} [options.runProcess] - injectable for tests
 * @returns {Promise<{directory: string, installed: boolean, output?: string}>}
 */
export async function prepareRehearsalHost({
  home, version, runProcess = runNpmInstall, registry,
}) {
  const exact = requireHostVersion(version)
  // Cached hosts are keyed by version. One shared directory silently booted whichever copy had been
  // downloaded first, so after a host upgrade the rehearsal proved the plugin on the *previous* host
  // line while the exemption was written for the new one.
  const root = rehearsalHostRoot(home, exact)
  const directory = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  if (cacheMatches(directory, exact)) return { directory, installed: false }
  mkdirSync(root, { recursive: true })
  const spec = `@deepseek-ai/dsh@${exact}`
  const args = [
    'install', '--prefix', root,
    // No lifecycle scripts: the host package is only ever booted, never built.
    '--ignore-scripts',
    '--no-audit', '--no-fund', '--silent', spec,
  ]
  if (registry !== undefined) args.push('--registry', registry)
  const result = await runProcess(args, { cwd: root })
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')
    throw new Error(`could not download a DSH host to rehearse against (${spec}): ${detail}`)
  }
  if (!existsSync(join(directory, 'package.json'))) {
    throw new Error(`the host install reported success but ${directory} is missing`)
  }
  return { directory, installed: true, output: result.stdout }
}

/**
 * How to launch npm without a shell.
 *
 * On Windows the npm entry point is a `.cmd` shim, and since the CVE-2024-27980 fix Node refuses to
 * spawn `.cmd`/`.bat` without `shell: true` — it throws `EINVAL`. So the desktop app, which is the
 * main case for downloading a rehearsal host, could never download one at all. Running the
 * JavaScript entry point with the same Node binary sidesteps the shim and keeps the no-shell rule.
 * @returns {{command: string, args: string[]}}
 */
function npmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args }
  const node = nodeCommand()
  const npmCli = join(dirname(node.command), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) return { command: node.command, args: [npmCli, ...args], env: node.env }
  return { command: 'npm.cmd', args }
}

/** Default runner: a real npm install, bounded by a timeout. */
function runNpmInstall(args, { cwd }) {
  return new Promise((resolveResult) => {
    const invocation = npmInvocation(args)
    const child = spawn(invocation.command, invocation.args, {
      // No shell: arguments are passed as an array, so nothing in them can become syntax.
      cwd,
      // In the desktop build the command is Electron, so it needs ELECTRON_RUN_AS_NODE to behave as
      // Node rather than launching a second copy of the application.
      env: invocation.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 300_000)
    child.on('error', (error) => { clearTimeout(timer); resolveResult({ ok: false, stdout, stderr: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolveResult({ ok: code === 0, exitCode: code, stdout, stderr }) })
  })
}
