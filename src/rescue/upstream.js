/**
 * Upstream tracking: tell the user when a temporary rescue can become permanent.
 *
 * A rescue exists because the *installed* version was rejected. The fix we are
 * waiting for is an upstream release, so the signal we watch is the registry:
 * once `dist-tags.latest` (or any published version) declares support for the
 * running host, the exemption is no longer needed and the user should upgrade
 * and undo the rescue.
 *
 * Deliberately conservative: a newer version that still rejects the host is
 * reported as `newer-but-still-incompatible` rather than as a fix, because
 * "a new version exists" and "a new version fixes this" are different claims.
 * @module rescue/upstream
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { evaluatePluginCompatibility } from '../compat/evaluate.js'

/** Cache lifetime for registry lookups so a rescan does not hammer npm. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Fetch a package manifest from a registry.
 * @param {string} name
 * @param {{registry?: string, fetchImpl?: Function}} [options]
 * @returns {Promise<object>}
 */
async function fetchPackument(name, { registry = 'https://registry.npmjs.org', fetchImpl = fetch } = {}) {
  const url = `${registry.replace(/\/$/u, '')}/${name.replace('/', '%2f')}`
  const response = await fetchImpl(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!response.ok) throw new Error(`registry responded ${response.status} for ${name}`)
  return response.json()
}

/**
 * Pick the highest published version that declares support for `runtimeVersion`.
 * @param {object} packument
 * @param {string} runtimeVersion
 * @returns {{latest?: string, newest?: string, fixed?: string}}
 */
export function selectUpstreamTarget(packument, runtimeVersion) {
  const versions = Object.keys(packument?.versions ?? {})
  const latest = packument?.['dist-tags']?.latest
  let newest
  let fixed
  for (const version of versions) {
    const manifest = packument.versions[version]
    if (newest === undefined || version.localeCompare(newest, undefined, { numeric: true }) > 0) newest = version
    let compatible = false
    try {
      compatible = evaluatePluginCompatibility(manifest, { runtimeVersion }) === undefined
    } catch {
      compatible = false
    }
    if (compatible && (fixed === undefined || version.localeCompare(fixed, undefined, { numeric: true }) > 0)) fixed = version
  }
  return { latest: typeof latest === 'string' ? latest : undefined, newest, fixed }
}

/**
 * Classify what the registry says about a rescued plugin.
 * @param {{installedVersion: string, runtimeVersion: string, target: {latest?: string, fixed?: string}}} input
 * @returns {'fix-available'|'newer-but-still-incompatible'|'no-upstream-release'|'unknown'}
 */
export function classifyUpstream({ installedVersion, runtimeVersion, target }) {
  if (target?.fixed === undefined) {
    if (target?.latest !== undefined && target.latest !== installedVersion) return 'newer-but-still-incompatible'
    return 'no-upstream-release'
  }
  if (target.fixed !== installedVersion) return 'fix-available'
  // The installed version itself now declares support; the exemption is redundant.
  return 'fix-available'
}

/**
 * Look up every rescued plugin, honouring the on-disk cache.
 * @param {object} options
 * @param {object[]} options.entries - rescue ledger entries
 * @param {string} options.profileDir - where the cache lives
 * @param {string} options.runtimeVersion
 * @param {number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<object[]>}
 */
export async function checkUpstream({
  entries, profileDir, runtimeVersion,
  now = Date.now(), ttlMs = DEFAULT_TTL_MS, fetchImpl, registry,
}) {
  const cachePath = join(profileDir, 'plugin-health-upstream.json')
  let cache = {}
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { cache = {} }
  const results = []
  let dirty = false
  for (const entry of entries) {
    const cacheKey = `${entry.name}@${runtimeVersion}`
    const cached = cache[cacheKey]
    let target
    if (cached && typeof cached.at === 'number' && now - cached.at < ttlMs) {
      target = cached.target
    } else {
      try {
        const packument = await fetchPackument(entry.name, { registry, ...(fetchImpl ? { fetchImpl } : {}) })
        target = selectUpstreamTarget(packument, runtimeVersion)
      } catch (error) {
        results.push({ ...entry, status: 'unknown', error: error.message })
        continue
      }
      cache[cacheKey] = { at: now, target }
      dirty = true
    }
    const status = classifyUpstream({ installedVersion: entry.version, runtimeVersion, target })
    results.push({ ...entry, status, target })
  }
  if (dirty) {
    try { writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`) } catch { /* cache is optional */ }
  }
  return results
}
