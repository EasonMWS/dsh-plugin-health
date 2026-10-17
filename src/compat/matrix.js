/**
 * Compatibility matrix over several DSH host versions.
 * Resolves host versions and plugin manifests, then applies the official evaluation semantics.
 * @module compat/matrix
 */
import semver from 'semver'
import { loadPackumentFromRegistry, mapLimit, DEFAULT_REGISTRY } from '../util/http.js'
import { evaluatePluginCompatibility } from './evaluate.js'

/**
 * Resolve host version specs (exact versions or npm dist-tags such as `latest`, `next`, `alpha`).
 * @param {readonly string[]} specs - versions or dist-tags.
 * @param {{registry?: string, loadPackument?: (registry: string, name: string) => Promise<any>}} [options]
 * @returns {Promise<string[]>} unique host semantic versions in input order.
 */
export async function resolveHostVersions(specs, { registry = DEFAULT_REGISTRY, loadPackument = loadPackumentFromRegistry } = {}) {
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('at least one host version or dist-tag is required')
  const packument = await loadPackument(registry, '@deepseek-ai/dsh')
  const distTags = packument['dist-tags'] ?? {}
  const versions = []
  for (const spec of specs) {
    const resolved = Object.hasOwn(distTags, spec) ? distTags[spec] : spec
    if (typeof resolved !== 'string' || semver.valid(resolved) === null) {
      throw new Error(`unknown DSH host version or dist-tag: ${spec}`)
    }
    if (!versions.includes(resolved)) versions.push(resolved)
  }
  return versions
}

/**
 * Split an npm plugin spec into name and optional version. Scoped names keep their leading `@`.
 * @param {string} spec - `name`, `name@version`, `@scope/name`, or `@scope/name@version`.
 * @returns {{name: string, version?: string}} parsed identity.
 */
export function parsePluginSpec(spec) {
  const text = String(spec).trim()
  if (text === '') throw new Error('empty plugin spec')
  const at = text.lastIndexOf('@')
  if (at > 0) return { name: text.slice(0, at), version: text.slice(at + 1) }
  return { name: text }
}

/**
 * Resolve plugin specs to manifests. A spec is a local directory when it exists on disk,
 * otherwise an npm package name with an optional exact version.
 * @param {readonly string[]} specs - plugin specifications.
 * @param {{cwd?: string, registry?: string, loadPackument?: (registry: string, name: string) => Promise<any>}} [options]
 * @returns {Promise<Array<{spec: string, name: string, version: string, manifest: object, source: 'npm'|'local', directory?: string}>>}
 */
export async function resolvePlugins(specs, { cwd = process.cwd(), registry = DEFAULT_REGISTRY, loadPackument = loadPackumentFromRegistry } = {}) {
  const { existsSync, readFileSync, statSync } = await import('node:fs')
  const { isAbsolute, join, resolve } = await import('node:path')
  const resolved = []
  for (const spec of specs) {
    const local = isAbsolute(spec) || spec.startsWith('.') || spec.startsWith('file:')
      ? spec
      : (existsSync(join(cwd, spec)) ? join(cwd, spec) : undefined)
    if (local !== undefined) {
      const directory = resolve(cwd, local.replace(/^file:/, ''))
      if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`not a plugin directory: ${spec}`)
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) throw new Error(`missing package.json in ${directory}`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') {
        throw new Error(`invalid package.json in ${directory}: name and version are required`)
      }
      resolved.push({ spec, name: manifest.name, version: manifest.version, manifest, source: 'local', directory })
      continue
    }
    const { name, version: requested } = parsePluginSpec(spec)
    const packument = await loadPackument(registry, name)
    const version = requested ?? packument['dist-tags']?.latest
    if (typeof version !== 'string' || semver.valid(version) === null) throw new Error(`cannot resolve a version for ${spec}`)
    const manifest = packument.versions?.[version]
    if (manifest === undefined) throw new Error(`${name}@${version} is not published`)
    resolved.push({ spec, name: manifest.name ?? name, version: manifest.version ?? version, manifest, source: 'npm' })
  }
  return resolved
}

/**
 * Best-effort repository URL from a plugin manifest.
 * @param {object} manifest - parsed package.json.
 * @returns {string|undefined} https URL.
 */
export function repositoryUrl(manifest) {
  const repository = manifest?.repository
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string') return undefined
  const normalized = raw.replace(/^git\+/, '').replace(/\.git$/, '')
  return /^https?:\/\//.test(normalized) ? normalized : undefined
}

/**
 * Evaluate resolved plugins against resolved hosts.
 * @param {Array<{name: string, version: string, manifest: object, source?: string}>} plugins - resolved plugins.
 * @param {readonly string[]} hosts - host semantic versions.
 * @param {{exemptions?: Record<string, readonly string[]>, generatedAt?: string}} [options]
 * @returns {object} serialisable matrix document.
 */
export function evaluateMatrix(plugins, hosts, { exemptions = {}, generatedAt = new Date().toISOString() } = {}) {
  const rows = plugins.map((plugin) => {
    const results = {}
    for (const host of hosts) {
      if (typeof plugin.error === 'string') {
        results[host] = { compatible: null, error: plugin.error }
        continue
      }
      try {
        const issue = evaluatePluginCompatibility(plugin.manifest, { exemptions, runtimeVersion: host })
        results[host] = issue === undefined
          ? { compatible: true }
          : { compatible: false, requirements: issue.requirements, exempted: issue.exempted }
      } catch (error) {
        results[host] = { compatible: null, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const values = Object.values(results)
    const compatible = values.filter((value) => value.compatible === true).length
    const incompatible = values.filter((value) => value.compatible === false).length
    const errors = values.filter((value) => value.compatible === null).length
    return {
      name: plugin.name,
      version: plugin.version ?? 'unknown',
      source: plugin.source ?? 'npm',
      repository: plugin.manifest === undefined ? undefined : repositoryUrl(plugin.manifest),
      ...(typeof plugin.error === 'string' ? { error: plugin.error } : {}),
      results,
      summary: { compatible, incompatible, errors },
    }
  })
  return { schemaVersion: 1, generatedAt, hosts: [...hosts], plugins: rows }
}

/**
 * Resolve, evaluate, and return a matrix in one call.
 * @param {{plugins: readonly string[], hosts: readonly string[], exemptions?: Record<string, readonly string[]>, cwd?: string, registry?: string, concurrency?: number, loadPackument?: Function}} options
 * @returns {Promise<object>} matrix document.
 */
export async function createMatrix({
  plugins, hosts, exemptions = {}, cwd, registry = DEFAULT_REGISTRY, concurrency = 6, loadPackument = loadPackumentFromRegistry,
}) {
  const hostVersions = await resolveHostVersions(hosts, { registry, loadPackument })
  const resolved = []
  for (const spec of plugins) {
    try {
      const [plugin] = await resolvePlugins([spec], { cwd, registry, loadPackument })
      resolved.push(plugin)
    } catch (error) {
      resolved.push({ spec, name: spec, source: 'unknown', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return evaluateMatrix(resolved, hostVersions, { exemptions })
}

/**
 * Count per-host results.
 * @param {object} matrix - matrix document.
 * @returns {Array<{host: string, compatible: number, incompatible: number, errors: number, total: number}>}
 */
export function hostSummary(matrix) {
  return matrix.hosts.map((host) => {
    let compatible = 0
    let incompatible = 0
    let errors = 0
    for (const plugin of matrix.plugins) {
      const result = plugin.results[host]
      if (result.compatible === true) compatible += 1
      else if (result.compatible === false) incompatible += 1
      else errors += 1
    }
    return { host, compatible, incompatible, errors, total: matrix.plugins.length }
  })
}

export { mapLimit, DEFAULT_REGISTRY }
