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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
 */
export function rehearsalHostRoot(home) {
  return join(home, '.plugin-health', 'host')
}

/**
 * Find an installed `@deepseek-ai/dsh` package that the rehearsal can boot through.
 * @param {string} home
 * @param {string} profileDir
 * @returns {string|undefined}
 */
export function discoverDshDirectory(home, profileDir) {
  const candidates = [
    // A copy this tool prepared earlier, so later runs do not download again.
    join(rehearsalHostRoot(home), 'node_modules', '@deepseek-ai', 'dsh'),
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh'),
    join(home, 'node_modules', '@deepseek-ai', 'dsh'),
    // A plain `npm install @deepseek-ai/dsh` in a scratch dir is the documented way
    // to rehearse a host version that is not the one currently in use.
    join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Install a host package for rehearsals when none is available.
 *
 * Only ever writes under `<home>/.plugin-health/host`, and only when the caller asked for a
 * rehearsal: a plain scan never triggers a download. The version matches what the profile
 * runs, because rehearsing against a different host would answer a different question.
 * @param {object} options
 * @param {string} options.home
 * @param {string} options.version - exact host version or dist-tag to install
 * @param {Function} [options.runProcess] - injectable for tests
 * @returns {Promise<{directory: string, installed: boolean, output?: string}>}
 */
export async function prepareRehearsalHost({
  home, version, runProcess = runNpmInstall, registry,
}) {
  const root = rehearsalHostRoot(home)
  const directory = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(join(directory, 'package.json'))) return { directory, installed: false }
  mkdirSync(root, { recursive: true })
  const spec = version === undefined || version === '' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`
  const args = ['install', '--prefix', root, '--no-audit', '--no-fund', '--silent', spec]
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

/** Default runner: a real npm install, bounded by a timeout. */
function runNpmInstall(args, { cwd }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
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
