/**
 * Which plugins the *next* host build will reject, judged from what they declare today.
 *
 * A plugin that enumerates exact prereleases (`0.2.1-rc.4 || 0.2.1-rc.5`) is accepted by every host it names
 * and rejected by the first one it does not. Its row is green right up to the release that breaks it, and
 * then its users find out by having it refused. The declaration already says this will happen; this module
 * reads it out ahead of time.
 *
 * "Next build" is two concrete versions, not a guess about the future: the next prerelease of the current
 * host (`0.2.2-rc.1` → `0.2.2-rc.2`) and the release that line is heading for (`0.2.2`). Neither may ever ship
 * under that exact number, which is why the result is called a forecast.
 */
import semver from 'semver'

import { unmetRequirements } from './evaluate.js'

/**
 * The versions a plugin would meet next on this host line.
 * @param {string} host - current host version.
 * @returns {string[]}
 */
export function nextBuildsOf(host) {
  const parsed = semver.parse(host)
  if (!parsed) return []
  if (parsed.prerelease.length > 0) {
    return [semver.inc(host, 'prerelease'), `${parsed.major}.${parsed.minor}.${parsed.patch}`]
  }
  return [semver.inc(host, 'patch')]
}

/** Rebuild the manifest fields the host evaluates, from a matrix row. */
function declarationManifest(row) {
  if (row.declared === 'engines') return { engines: { dsh: row.declaredRanges?.['engines.dsh'] } }
  if (row.declared === 'peers') return { peerDependencies: row.declaredRanges ?? {} }
  return {}
}

/**
 * For a row accepted on `host`, the next builds its declaration would reject.
 *
 * Only rows accepted today are forecast: a rejected row is already a finding, and an undeclared one is never
 * checked by the gate at all.
 *
 * @param {object} row - matrix row with `declared` and `declaredRanges` (B6).
 * @param {string} host - current host version.
 * @returns {{atRisk: boolean, rejects: string[], checked: string[]}|null} null when not applicable.
 */
export function forecastRow(row, host) {
  if (row?.results?.[host]?.compatible !== true) return null
  if (row.declared !== 'engines' && row.declared !== 'peers') return null
  const manifest = declarationManifest(row)
  const checked = nextBuildsOf(host)
  const rejects = checked.filter((version) => {
    try {
      return Object.keys(unmetRequirements(manifest, version)).length > 0
    } catch {
      return false
    }
  })
  return { atRisk: rejects.length > 0, rejects, checked }
}
