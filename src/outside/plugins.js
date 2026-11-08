/**
 * The plugin list a standalone manager can act on, and the one write it performs.
 *
 * What this is for: when DSH will not start, there is no panel to open and no CLI to run — for a desktop
 * install, `dsh plugin` is not on PATH at all. This is the surface that still works.
 *
 * What it deliberately does not do: install, uninstall, or update. Those run a package manager, which
 * executes whatever postinstall scripts the package ships, and on Windows there is no sandbox to put them
 * in — measured, not assumed. Downloading stays inside DSH, which owns that decision. This module shows the
 * facts and flips the switch that is already there.
 * @module outside/plugins
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { evaluatePluginCompatibility } from '../compat/evaluate.js'
import { hostStatus } from './hostlock.js'
import { disablePlugin, enablePlugin, readProfilePatch } from '../rescue/boot.js'
import { inspectDshHome, listInstalledPlugins } from '../repair/inspect.js'

/**
 * Read the profile manifest, or nothing.
 * @param {string} profileDir
 */
function readManifest(profileDir) {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Which plugin names carry a `disabled: true` overlay.
 *
 * The overlay lives in cordis.patch.yml and is matched by id or by name, so both are collected.
 *
 * @param {string} profileDir
 * @returns {Set<string>}
 */
export function disabledNames(profileDir) {
  const names = new Set()
  let entries = []
  try {
    entries = readProfilePatch(profileDir)
  } catch {
    return names
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.disabled !== true) continue
    if (typeof entry.name === 'string' && entry.name !== '') names.add(entry.name)
    if (typeof entry.id === 'string' && entry.id !== '') names.add(entry.id)
  }
  return names
}

/**
 * Every installed plugin, with the two facts a manager needs: is it on, and does its declaration admit the
 * running host.
 *
 * @param {{home: string, profile: string, runtimeVersion?: string}} options
 * @returns {{
 *   ok: boolean,
 *   profile: string,
 *   profileDir: string,
 *   runtimeVersion: string|undefined,
 *   plugins: Array<{name: string, version: string|null, enabled: boolean, compatibility: string, reason: string, source: string}>,
 *   error?: string,
 * }}
 */
export function listPlugins({ home, profile, runtimeVersion }) {
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) {
    return { ok: false, profile, profileDir, runtimeVersion, plugins: [], error: `no profile at ${profileDir}` }
  }

  const manifest = readManifest(profileDir)
  const inspected = inspectDshHome({ home, profile, runtimeVersion })
  const disabled = disabledNames(profileDir)

  let installed = []
  try {
    installed = listInstalledPlugins(profileDir, manifest ?? {})
  } catch {
    installed = []
  }

  const rejected = new Map()
  for (const row of inspected.incompatiblePlugins ?? []) {
    if (typeof row?.name === 'string') rejected.set(row.name, row)
  }

  const plugins = installed.map((row) => {
    const dir = row.directory ?? join(profileDir, 'node_modules', ...String(row.name).split('/'))
    let version = null
    let compatibility = 'unknown'
    let reason = ''

    // The version that actually runs is the one in the directory on disk, not the range in the manifest.
    let pluginManifest
    try {
      pluginManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (typeof pluginManifest.version === 'string') version = pluginManifest.version
    } catch { /* a missing manifest leaves the version unknown */ }

    if (pluginManifest !== undefined && runtimeVersion !== undefined) {
      try {
        // undefined means "no unmet requirement", which is the compatible case. An issue object carries the
        // requirements that were not met.
        const issue = evaluatePluginCompatibility(pluginManifest, { runtimeVersion })
        if (issue === undefined) {
          compatibility = 'compatible'
        } else {
          compatibility = issue.exempted === true ? 'exempted' : 'incompatible'
          const requirements = issue.requirements ?? {}
          reason = Object.entries(requirements).map(([field, range]) => `${field} ${String(range)}`).join(', ')
        }
      } catch {
        compatibility = 'unknown'
      }
    } else if (rejected.has(row.name)) {
      compatibility = 'incompatible'
    }

    // A name can reach this list from the patch layer alone, with no package behind it. Saying so is the
    // difference between a mystery row and an answer.
    if (version === null && reason === '') {
      reason = row.source === 'patch'
        ? 'not installed; only a patch overlay remains'
        : 'the package manifest could not be read'
    }

    // The host's own packages are not plugins a manager switches off. Kept in the list so the count is
    // honest, but flagged so the UI can leave them out.
    const hostPackage = row.name.startsWith('@deepseek-ai/')

    return {
      name: row.name,
      version,
      enabled: !disabled.has(row.name),
      compatibility,
      reason: typeof reason === 'string' ? reason : '',
      source: typeof row.source === 'string' ? row.source : 'unknown',
      hostPackage,
    }
  })

  // Disabled entries can exist for a plugin that is no longer installed; report them rather than hide the
  // patch residue, because it is what the user will ask about when the plugin reappears.
  for (const name of disabled) {
    if (plugins.some((row) => row.name === name)) continue
    plugins.push({ name, version: null, enabled: false, compatibility: 'unknown', reason: 'not installed; only a disable overlay remains', source: 'patch', hostPackage: name.startsWith('@deepseek-ai/') })
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name))
  return {
    ok: true,
    profile,
    profileDir,
    runtimeVersion,
    plugins,
    counts: {
      total: plugins.length,
      // What a manager can act on: installed, third-party, not the host itself.
      manageable: plugins.filter((row) => row.hostPackage !== true && row.version !== null).length,
      disabled: plugins.filter((row) => row.enabled !== true).length,
    },
  }
}

/**
 * Turn one plugin on or off.
 *
 * Two rules, both about not corrupting a profile that something is using:
 *
 *   1. Refuse while DSH is running. The host reads cordis.patch.yml at startup and may rewrite it; writing
 *      underneath it is how a profile ends up in a state nobody planned.
 *   2. Take a snapshot first. This write is reversible, and the way to make that true is to have the
 *      previous bytes on disk before touching them.
 *
 * @param {{
 *   home: string,
 *   profile: string,
 *   name: string,
 *   enabled: boolean,
 *   runtimeVersion?: string,
 *   takeSnapshot: (home: string, profile: string, options: {reason: string}) => {ok: boolean, id?: string, error?: string},
 *   force?: boolean,
 * }} options
 * @returns {{ok: true, changed: boolean, reason: string, snapshot?: string} | {ok: false, error: string, reason?: string}}
 */
export function setPluginEnabled({
  home, profile, name, enabled, runtimeVersion, takeSnapshot, force = false,
}) {
  if (typeof name !== 'string' || name === '') return { ok: false, error: 'a plugin name is required', reason: 'bad-request' }

  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) return { ok: false, error: `no profile at ${profileDir}`, reason: 'no-profile' }

  // The host must not be running while its configuration is edited.
  const host = hostStatus(home, profile)
  if (host.running === true && force !== true) {
    return {
      ok: false,
      reason: 'host-running',
      error: `DSH is running (pid ${host.pid}); close it before changing plugin state`,
    }
  }

  const installed = listPlugins({ home, profile, runtimeVersion })
  const known = installed.plugins.find((row) => row.name === name)
  if (known === undefined && enabled === true) {
    // Enabling something that is not installed would only leave an overlay for a plugin that never loads.
    return { ok: false, error: `${name} is not installed in ${profile}`, reason: 'not-installed' }
  }

  // A snapshot before the write, so the previous state is recoverable even if this tool is wrong.
  let snapshot
  try {
    const taken = takeSnapshot(home, profile, { reason: `${enabled ? 'enable' : 'disable'}-${name}` })
    if (taken?.ok !== true) return { ok: false, error: `could not take a snapshot first: ${taken?.error ?? 'unknown'}`, reason: 'snapshot-failed' }
    snapshot = taken.id
  } catch (error) {
    return { ok: false, error: `could not take a snapshot first: ${error instanceof Error ? error.message : String(error)}`, reason: 'snapshot-failed' }
  }

  try {
    const result = enabled === true
      ? enablePlugin(profileDir, { name })
      : disablePlugin(profileDir, { name })
    const changed = result?.changed === true
    return {
      ok: true,
      changed,
      reason: typeof result?.reason === 'string' ? result.reason : (changed ? 'changed' : 'unchanged'),
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), reason: 'write-failed' }
  }
}