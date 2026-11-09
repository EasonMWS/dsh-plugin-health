/**
 * Compatibility matrix over several DSH host versions.
 * Resolves host versions and plugin manifests, then applies the official evaluation semantics.
 * @module compat/matrix
 */
import semver from 'semver'
import { loadPackumentFromRegistry, mapLimit, DEFAULT_REGISTRY } from '../util/http.js'
import { evaluatePluginCompatibility } from './evaluate.js'

/**
 * Choose the hosts worth showing on a compatibility page, from the registry's own dist-tags.
 *
 * The problem this solves was real: the page asked for `latest,next,alpha`, and on 2026-11-08 `alpha`
 * pointed at `0.2.2-alpha.3` — a release from five days *before* the latest, `0.2.2-rc.1`. The page then had
 * two columns, one of them an outdated prerelease, and 135 plugins were counted as rejected because of it.
 * A plugin requiring `>=0.2.2-rc.1` is correctly rejected by `alpha.3` and correctly accepted by `rc.1`, so
 * the headline number said the opposite of what a current user experiences.
 *
 * So: latest always, a dist-tag only when it points ahead of latest, and the previous minor line because a
 * desktop install can ship a host older than npm's latest.
 *
 * @param {object} packument - the `@deepseek-ai/dsh` registry document.
 * @returns {{hosts: string[], roles: Record<string, string>, dropped: Array<{spec: string, version: string|null, reason: string}>}}
 */
export function selectCurrentHosts(packument) {
  const distTags = packument?.['dist-tags'] ?? {}
  const latest = distTags.latest
  if (typeof latest !== 'string' || semver.valid(latest) === null) {
    throw new Error('the registry did not report a valid latest DSH version')
  }
  const latestParsed = semver.parse(latest)

  const hosts = [latest]
  const roles = { [latest]: 'latest' }
  const dropped = []

  for (const [tag, version] of Object.entries(distTags)) {
    if (tag === 'latest') continue
    if (typeof version !== 'string' || semver.valid(version) === null) {
      dropped.push({ spec: tag, version: typeof version === 'string' ? version : null, reason: 'not a semantic version' })
      continue
    }
    if (semver.eq(version, latest)) {
      // `next` and `latest` point at the same release most of the time. A duplicate column is not an error,
      // it is just nothing new, and the caller is told so rather than silently given a shorter list.
      dropped.push({ spec: tag, version, reason: `points at the same version as latest (${latest})` })
      continue
    }
    if (!semver.gt(version, latest)) {
      dropped.push({ spec: tag, version, reason: `older than latest (${latest})` })
      continue
    }
    if (!hosts.includes(version)) {
      hosts.push(version)
      roles[version] = tag
    }
  }

  // The highest version on the release line below latest. Prereleases count: 0.2.1-rc.5 is the newest of
  // the 0.2.1 line even though it never shipped stable.
  //
  // "Line" means the major.minor.patch triple, not major.minor. The remediation notes describe this as
  // "major.minor" but also expect 0.2.1-rc.5 for a latest of 0.2.2-rc.1 — and in semver 0.2.1 and 0.2.2
  // share major.minor, differing only in patch. The two cannot both be true. The expectation is the one
  // that matches the stated purpose ("a desktop client can ship a host older than npm's latest"), so the
  // triple is what this compares.
  const lineOf = (version) => {
    const parsed = semver.parse(version)
    return [parsed.major, parsed.minor, parsed.patch]
  }
  const latestLine = lineOf(latest)
  const onEarlierLine = (version) => {
    const line = lineOf(version)
    for (let index = 0; index < 3; index += 1) {
      if (line[index] !== latestLine[index]) return line[index] < latestLine[index]
    }
    return false
  }

  const previous = Object.keys(packument?.versions ?? {})
    .filter((version) => semver.valid(version) !== null && onEarlierLine(version))
    .sort(semver.rcompare)[0]

  if (previous !== undefined && !hosts.includes(previous)) {
    hosts.push(previous)
    roles[previous] = 'previous'
  }

  return { hosts, roles, dropped }
}

/**
 * Resolve host specs to versions, keeping the roles and the discards.
 *
 * `current` is the only spec with special meaning beyond a dist-tag: it expands to `selectCurrentHosts`.
 * Every other spec keeps its old meaning, so existing invocations behave exactly as before.
 *
 * @param {readonly string[]} specs - versions, dist-tags, or `current`.
 * @param {{registry?: string, loadPackument?: (registry: string, name: string) => Promise<any>}} [options]
 * @returns {Promise<{hosts: string[], roles?: Record<string, string>, dropped?: Array<object>}>}
 */
export async function resolveHostSelection(specs, { registry = DEFAULT_REGISTRY, loadPackument = loadPackumentFromRegistry } = {}) {
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('at least one host version or dist-tag is required')
  const packument = await loadPackument(registry, '@deepseek-ai/dsh')
  const distTags = packument['dist-tags'] ?? {}
  const hosts = []
  let roles
  let dropped

  for (const spec of specs) {
    if (spec === 'current') {
      const selection = selectCurrentHosts(packument)
      roles = { ...(roles ?? {}), ...selection.roles }
      dropped = [...(dropped ?? []), ...selection.dropped]
      for (const host of selection.hosts) {
        if (!hosts.includes(host)) hosts.push(host)
      }
      continue
    }
    const resolved = Object.hasOwn(distTags, spec) ? distTags[spec] : spec
    if (typeof resolved !== 'string' || semver.valid(resolved) === null) {
      throw new Error(`unknown DSH host version or dist-tag: ${spec}`)
    }
    if (!hosts.includes(resolved)) hosts.push(resolved)
  }

  return {
    hosts,
    ...(roles === undefined ? {} : { roles }),
    ...(dropped === undefined ? {} : { dropped }),
  }
}

/**
 * Resolve host version specs (exact versions or npm dist-tags such as `latest`, `next`, `alpha`).
 * @param {readonly string[]} specs - versions or dist-tags.
 * @param {{registry?: string, loadPackument?: (registry: string, name: string) => Promise<any>}} [options]
 * @returns {Promise<string[]>} unique host semantic versions in input order.
 */
export async function resolveHostVersions(specs, options = {}) {
  const { hosts } = await resolveHostSelection(specs, options)
  return hosts
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
    // The registry records a publish timestamp per version. It lets a reader tell a maintained
    // plugin from one that has not been touched since before the host they are running existed.
    const publishedAt = typeof packument.time?.[version] === 'string' ? packument.time[version] : undefined
    resolved.push({ spec, name: manifest.name ?? name, version: manifest.version ?? version, manifest, source: 'npm', publishedAt })
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
      ...(typeof plugin.publishedAt === 'string' ? { publishedAt: plugin.publishedAt } : {}),
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
  const selection = await resolveHostSelection(hosts, { registry, loadPackument })
  const resolved = []
  for (const spec of plugins) {
    try {
      const [plugin] = await resolvePlugins([spec], { cwd, registry, loadPackument })
      resolved.push(plugin)
    } catch (error) {
      resolved.push({ spec, name: spec, source: 'unknown', error: error instanceof Error ? error.message : String(error) })
    }
  }
  const matrix = evaluateMatrix(resolved, selection.hosts, { exemptions })
  // Only present when the caller asked for `current`. Absent means "this matrix was not built from a
  // selection", which the page must not mistake for "the selection had no roles".
  if (selection.roles !== undefined) matrix.hostRoles = selection.roles
  if (selection.dropped !== undefined) matrix.hostsDropped = selection.dropped
  return matrix
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
