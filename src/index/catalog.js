/**
 * Catalog loading and normalisation for the official format-1 market index builder.
 * @module index/catalog
 */
import { readFile } from 'node:fs/promises'
import { fetchJson } from '../util/http.js'

/**
 * Load a plugin catalog from a URL or a local JSON file.
 *
 * Supported document: the awesome-dsh-plugin snapshot (`{ categories, plugins: [...] }`).
 * Every plugin entry is expected to carry at least `name`; npm entries also carry `npm`.
 * @param {string} source - http(s) URL or local path.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{entries: object[], categories: object, meta: object}>}
 */
export async function loadCatalog(source, { timeoutMs = 120_000 } = {}) {
  const document = /^https?:\/\//i.test(source)
    ? await fetchJson(source, { timeoutMs, retries: 1 })
    : JSON.parse(await readFile(source, 'utf8'))
  if (document === null || typeof document !== 'object' || !Array.isArray(document.plugins)) {
    throw new Error('unsupported catalog: expected a JSON document with a plugins array (awesome-dsh-plugin snapshot)')
  }
  return {
    entries: document.plugins,
    categories: document.categories ?? {},
    meta: {
      name: document.name ?? 'catalog',
      url: document.url ?? (typeof source === 'string' ? source : undefined),
      updated: document.updated ?? document.generated_at,
      declaredCount: document.count,
    },
  }
}

/**
 * Keep entries that publish an npm package.
 * @param {readonly object[]} entries - catalog entries.
 * @returns {object[]} npm entries.
 */
export function npmEntries(entries) {
  return entries.filter((entry) => entry !== null && typeof entry === 'object'
    && typeof entry.npm === 'string' && entry.npm.trim() !== '')
}

/**
 * Look up a compatibility result by plugin package name from a matrix document.
 * @param {object|undefined} matrix - matrix document from `dsh-plugin-health matrix`.
 * @param {string|undefined} preferredHost - host version to read; defaults to the first matrix host.
 * @returns {(packageName: string) => boolean|undefined} lookup function.
 */
export function compatibilityLookup(matrix, preferredHost) {
  if (matrix === undefined || matrix === null || !Array.isArray(matrix.plugins)) return () => undefined
  const host = preferredHost !== undefined && Array.isArray(matrix.hosts) && matrix.hosts.includes(preferredHost)
    ? preferredHost
    : matrix.hosts?.[0]
  if (typeof host !== 'string') return () => undefined
  const results = new Map()
  for (const plugin of matrix.plugins) {
    const result = plugin?.results?.[host]
    if (result !== undefined && typeof result.compatible === 'boolean') results.set(plugin.name, result.compatible)
  }
  return (packageName) => results.get(packageName)
}
