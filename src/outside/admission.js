/**
 * Decide whether a profile is safe to start, before anything runs.
 *
 * This is the one thing only an outside tool can do. Once DSH is up, whatever a plugin does happens
 * inside it; by then the only options are recovery. Before it starts, the profile is just files, and
 * files can be read without executing them.
 *
 * What this deliberately does NOT do is call a plugin dangerous. It reports facts a person can act on
 * — which plugins the host you are about to run would reject, what lives in a plugin's dependency
 * tree, whether anything carries an install script — and leaves the decision where it belongs.
 * @module outside/admission
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { inspectDshHome, listInstalledPlugins } from '../repair/inspect.js'
import { pluginFingerprint } from '../state/shared.js'

/** Lifecycle scripts npm runs at install time. This is where published malware usually acts. */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare']

/** Stop walking after this many packages, so a huge tree cannot stall the check. */
const MAX_WALKED = 400

/**
 * List what looks like a package directory, following symlinks.
 *
 * pnpm links every package into node_modules as a symlink, and Dirent#isDirectory() is false for
 * those — so filtering on it skips the entire tree on any pnpm profile, which is exactly the layout
 * DSH uses. Resolve each entry instead.
 */
function listDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory()) return true
        if (!entry.isSymbolicLink()) return false
        try {
          return statSync(join(dir, entry.name)).isDirectory()
        } catch {
          return false // a broken link is not a package
        }
      })
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Read a manifest without trusting it to exist or to be JSON. */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Which lifecycle scripts a package would run.
 *
 * A script is not evidence of malice — native modules legitimately need to build — but it is the one
 * thing that executes during `npm install`, before any of this tool's checks can run.
 *
 * @param {object|null} manifest
 * @returns {string[]}
 */
export function installHooks(manifest) {
  const scripts = manifest?.scripts
  if (scripts === null || typeof scripts !== 'object') return []
  return INSTALL_HOOKS.filter((hook) => typeof scripts[hook] === 'string' && scripts[hook].trim() !== '')
}

/**
 * Inventory what is actually installed under a directory's node_modules, including nested trees.
 *
 * What runs is the tree on disk, not the ranges that were declared, so this walks the directory.
 *
 * @param {string} rootDir
 * @returns {Array<{name: string, version: string, hooks: string[]}>}
 */
export function dependencyInventory(rootDir) {
  const found = []
  const seen = new Set()

  const walk = (dir, depth) => {
    if (found.length >= MAX_WALKED || depth > 8) return
    const modules = join(dir, 'node_modules')

    for (const entry of listDirectories(modules)) {
      if (found.length >= MAX_WALKED) return
      // Scoped packages sit one level deeper.
      const packageDirs = entry.startsWith('@')
        ? listDirectories(join(modules, entry)).map((sub) => join(modules, entry, sub))
        : [join(modules, entry)]

      for (const packageDir of packageDirs) {
        const manifest = readManifest(packageDir)
        if (manifest === null || typeof manifest.name !== 'string') continue
        const key = `${manifest.name}@${manifest.version ?? '?'}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({
          name: manifest.name,
          version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
          hooks: installHooks(manifest),
        })
        walk(packageDir, depth + 1)
      }
    }
  }

  walk(rootDir, 0)
  return found
}

/**
 * Every installed plugin with the version that is actually on disk.
 *
 * listInstalledPlugins reports name, directory and source but not a version, so using it directly
 * produces a fingerprint that cannot notice an upgrade. The manifest in each directory is what will
 * run, so the version is read from there.
 *
 * @param {string} home
 * @param {string} profile
 * @param {string} [profileDir]
 * @returns {Array<{name: string, version: string}>}
 */
function installedWithVersions(home, profile, profileDir) {
  const dir = typeof profileDir === 'string' && profileDir !== '' ? profileDir : join(home, 'profiles', profile)
  let list
  try {
    list = listInstalledPlugins(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
  } catch {
    return []
  }
  return list.map((row) => {
    let version = '?'
    try {
      const manifest = JSON.parse(readFileSync(join(row.directory, 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string' && manifest.version !== '') version = manifest.version
    } catch { /* a missing manifest does not stop the fingerprint */ }
    return { name: row.name, version }
  })
}

/**
 * Build the admission report for a profile.
 *
 * @param {{home: string, profile: string, runtimeVersion?: string, targetVersion?: string}} options
 * @returns {object}
 */
export function admissionReport({ home, profile, runtimeVersion, targetVersion }) {
  const inspected = inspectDshHome({ home, profile, runtimeVersion })

  // inspectDshHome reports what it found, not what is installed: a rejected plugin arrives in
  // incompatiblePlugins, and the scanned count arrives in scannedPlugins.
  const rejected = Array.isArray(inspected.incompatiblePlugins) ? inspected.incompatiblePlugins : []
  const scanned = inspected.scannedPlugins ?? {}
  const installed = installedWithVersions(home, profile, inspected.profileDir)

  const findings = []

  // 1. Plugins the host you are about to run would refuse. This is what the tool exists for, and it is
  //    knowable before starting: it is a comparison of a declaration against a version string.
  for (const row of rejected) {
    findings.push({
      kind: 'would-be-rejected',
      severity: 'block',
      plugin: row.name,
      version: row.version ?? null,
      detail: row.requirements ?? {},
    })
  }

  // 2. Anything that runs an install script. Reported as a fact, not a verdict: a native module needs
  //    one, so the count alone says nothing about intent.
  // The walker looks for node_modules inside the directory it is given, so give it the profile.
  const tree = dependencyInventory(join(home, 'profiles', profile))
  for (const entry of tree) {
    if (entry.hooks.length === 0) continue
    findings.push({
      kind: 'install-script',
      severity: 'warn',
      plugin: entry.name,
      version: entry.version,
      detail: { hooks: entry.hooks, depth: 'dependency' },
    })
  }

  const blocking = findings.filter((row) => row.severity === 'block')
  const verdict = blocking.length > 0 ? 'block' : findings.length > 0 ? 'warn' : 'pass'

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    profile,
    runtimeVersion: runtimeVersion ?? null,
    targetVersion: targetVersion ?? null,
    verdict,
    fingerprint: pluginFingerprint(installed.length > 0 ? installed : rejected),
    pluginCount: typeof scanned.total === 'number' ? Math.max(scanned.total, installed.length) : installed.length,
    blockedByDeclaration: rejected.length,
    dependencyCount: tree.length,
    findings,
    // What this check did not look at. A report that lists its own blind spots is harder to misread
    // as a clean bill of health.
    limits: [
      'declarations-and-files-only',
      'install-hooks-reported-not-executed',
      'no-runtime-behaviour-observed',
      'transitive-tree-capped-at-' + MAX_WALKED,
    ],
  }
}
