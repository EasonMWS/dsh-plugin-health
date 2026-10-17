/**
 * Official DSH plugin compatibility semantics, mirrored from
 * `packages/boot/app-boot/src/plugin-compatibility.ts` (deepseek-ai/deepseek-harness):
 *
 * - `engines.dsh` decides alone when present; `peerDependencies` are then ignored.
 * - Otherwise every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range must match.
 * - Prereleases participate in ranges (`includePrerelease: true`).
 * - `workspace:^`, `workspace:~`, and `workspace:*` peer ranges mean the running host version.
 * - An exact-version exemption maps `name@version` to exact runtime versions.
 *
 * The hosted `@deepseek-ai/dsh-app-boot` build does not export this helper, so this module keeps a
 * small, tested copy; `test/compat.test.js` fixes the behaviour.
 * @module compat/evaluate
 */
import semver from 'semver'

function objectOf(value, field) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value
}

function runtimeVersionOf(value) {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(`Invalid dsh runtime version: ${JSON.stringify(value)}; expected a semantic version`)
  }
  return value
}

function identityField(manifest, field) {
  const value = Object.hasOwn(manifest, field) ? manifest[field] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Plugin manifest ${field} must be a non-empty string when dsh requirements are unmet`)
  }
  return value
}

/**
 * Evaluate one SemVer range exactly as DSH does: empty ranges never match, prereleases participate.
 * @param {string} runtimeVersion - semantic version of the host.
 * @param {string} range - SemVer range.
 * @returns {boolean} whether the range accepts the runtime.
 */
export function satisfiesDshRange(runtimeVersion, range) {
  if (typeof range !== 'string' || range.trim() === '') return false
  return semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}

/**
 * Collect the unmet DSH requirements of a plugin manifest.
 * @param {object} manifest - parsed package.json.
 * @param {string} runtimeVersion - valid host semantic version.
 * @returns {Record<string,string>} unmet requirement map: `engines.dsh` or peer package names.
 */
export function unmetRequirements(manifest, runtimeVersion) {
  const fields = objectOf(manifest, 'Plugin manifest')
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfiesDshRange(runtimeVersion, range) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {}
  const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies')
  const unmet = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (!satisfiesDshRange(runtimeVersion, requirement)) unmet[name] = range
  }
  return unmet
}

/**
 * Evaluate a plugin manifest against one host version.
 * @param {object} manifest - parsed package.json.
 * @param {{exemptions?: Record<string, readonly string[]>, runtimeVersion: string}} options - exact-version exemptions and host version.
 * @returns {{name: string, version: string, runtimeVersion: string, requirements: Record<string,string>, exempted: boolean} | undefined}
 *   `undefined` when compatible (or exempted handling is left to the caller), otherwise the unmet requirements.
 * @throws {Error} for malformed manifests or runtime versions.
 */
export function evaluatePluginCompatibility(manifest, { exemptions = {}, runtimeVersion }) {
  runtimeVersionOf(runtimeVersion)
  const fields = objectOf(manifest, 'Plugin manifest')
  const requirements = unmetRequirements(fields, runtimeVersion)
  if (Object.keys(requirements).length === 0) return undefined
  const name = identityField(fields, 'name')
  const version = identityField(fields, 'version')
  const key = `${name}@${version}`
  const exemptedVersions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined
  const exempted = Array.isArray(exemptedVersions) && exemptedVersions.includes(runtimeVersion)
  return { name, version, runtimeVersion, requirements, exempted }
}

/**
 * Render the official English diagnostic for one incompatibility.
 * @param {{name: string, version: string, runtimeVersion: string, requirements: Record<string,string>, exempted: boolean}} issue
 * @returns {string} warning text.
 */
export function pluginCompatibilityWarning(issue) {
  const key = `${issue.name}@${issue.version}`
  return `Plugin ${key} is incompatible with dsh ${issue.runtimeVersion}: requirements ${JSON.stringify(issue.requirements)}. `
    + 'Running it may cause crashes or data loss. '
    + 'Update the plugin or install a plugin version compatible with this dsh runtime. '
    + `To accept this risk explicitly, grant the exact-version exemption for ${key} on dsh ${issue.runtimeVersion} with \`dsh plugin allow-version\` or the plugin manager, then retry the installation or restart dsh. `
    + `Exact-version exemption: ${issue.exempted ? 'active' : 'not active'}.`
}
