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
import { existsSync, readFileSync } from 'node:fs'
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
 * Find an installed `@deepseek-ai/dsh` package that the rehearsal can boot through.
 * @param {string} home
 * @param {string} profileDir
 * @returns {string|undefined}
 */
export function discoverDshDirectory(home, profileDir) {
  const candidates = [
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
