/**
 * What a smoke result needs to be reproducible: the exact packages that were installed, the tool that judged
 * them, and the environment it ran in.
 *
 * A result that only says "plugin X passed on host Y" cannot be audited. X could have been any version the
 * registry served that day, and a later re-run can disagree without anyone being able to say why. Everything
 * here is best-effort: missing evidence is recorded as missing, and never turns a passing run into a failure.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const OWN_MANIFEST = new URL('../../package.json', import.meta.url)

/** `{ name, version }` of this tool, read from its own manifest. */
export function toolIdentity() {
  try {
    const manifest = JSON.parse(readFileSync(OWN_MANIFEST, 'utf8'))
    return { name: manifest.name, version: manifest.version }
  } catch {
    return { name: 'dsh-plugin-health', version: null }
  }
}

/**
 * Ask pnpm on PATH for its version.
 *
 * The official CLI installs through whatever pnpm is on PATH, so that is the version that shaped the install.
 * `pnpm` is a shell shim on Windows (`pnpm.cmd`), which `execFile` can only start through a shell; the
 * argument list is constant, so nothing from a plugin or a request reaches that shell.
 *
 * @param {{env?: object, timeoutMs?: number}} [options]
 * @returns {Promise<string|null>}
 */
export function probePnpmVersion({ env = process.env, timeoutMs = 5000 } = {}) {
  return new Promise((resolveVersion) => {
    try {
      execFile('pnpm', ['--version'], { env, timeout: timeoutMs, shell: process.platform === 'win32', windowsHide: true },
        (error, stdout) => {
          const version = String(stdout ?? '').trim()
          resolveVersion(!error && /^\d+\.\d+\.\d+/u.test(version) ? version : null)
        })
    } catch {
      resolveVersion(null)
    }
  })
}

/**
 * Runtime facts recorded next to every result.
 * @param {{cordis?: string|null, pnpm?: string|null}} known
 */
export function runtimeEnvironment({ cordis = null, pnpm = null } = {}) {
  return { node: process.version, platform: process.platform, arch: process.arch, pnpm, cordis }
}

/** Strip pnpm's peer suffix: `1.2.3(react@18.0.0)` is the package at `1.2.3`. */
function bareVersion(version) {
  return typeof version === 'string' ? version.replace(/\(.*$/u, '') : null
}

/**
 * Read what was actually installed for each subject, from the profile pnpm wrote.
 *
 * Sources, in order: the profile's `package.json` says which packages were asked for, and `pnpm-lock.yaml`
 * says which version was resolved and with which integrity. A subject that cannot be read is still listed,
 * with `evidenceError`, so a reader sees the gap instead of a shorter list.
 *
 * @param {string} profileDirectory - `<DSH_HOME>/profiles/<profile>`.
 * @param {string[]} [names] - packages under test; when omitted, every non-official dependency.
 * @returns {Array<{name: string, version: string|null, integrity: string|null, resolution: string|null, evidenceError?: string}>}
 */
export function readSubjects(profileDirectory, names) {
  let dependencies = {}
  let lock = null
  let lockError = null
  try {
    dependencies = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')).dependencies ?? {}
  } catch (error) {
    if (!names?.length) return []
    lockError = `profile package.json unreadable: ${error.message}`
  }
  const lockPath = join(profileDirectory, 'pnpm-lock.yaml')
  if (existsSync(lockPath)) {
    try { lock = parseYaml(readFileSync(lockPath, 'utf8')) } catch (error) { lockError = `pnpm-lock.yaml unreadable: ${error.message}` }
  } else lockError ??= 'pnpm-lock.yaml not found'

  const wanted = names?.length
    ? names
    : Object.keys(dependencies).filter((name) => !name.startsWith('@deepseek-ai/')).sort()
  const importer = lock?.importers?.['.'] ?? {}
  const locked = { ...(importer.devDependencies ?? {}), ...(importer.optionalDependencies ?? {}), ...(importer.dependencies ?? {}) }

  return wanted.map((name) => {
    const entry = locked[name]
    const raw = typeof entry === 'object' && entry !== null ? entry.version : entry
    const version = bareVersion(raw)
    if (!version) {
      return { name, version: null, integrity: null, resolution: null, evidenceError: lockError ?? `${name} is not in pnpm-lock.yaml` }
    }
    if (/^(?:file|link|workspace):/u.test(version)) {
      return { name, version: null, integrity: null, resolution: version.split(':')[0] }
    }
    const record = lock?.packages?.[`${name}@${version}`] ?? lock?.packages?.[`/${name}@${version}`] ?? lock?.packages?.[`/${name}/${version}`]
    const integrity = record?.resolution?.integrity ?? null
    const tarball = record?.resolution?.tarball ?? null
    return {
      name, version,
      integrity,
      resolution: tarball && !integrity ? 'tarball' : 'registry',
      ...(integrity || tarball ? {} : { evidenceError: `no resolution for ${name}@${version} in pnpm-lock.yaml` }),
    }
  })
}
