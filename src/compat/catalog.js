/**
 * Load the community catalog and reduce it to the metadata the compatibility table cannot get from
 * npm: the category a plugin was filed under, and the date it was added.
 *
 * The catalog is either a URL or a local path, matching how `index --catalog` already works. Failure
 * is not fatal — a table without categories is still a useful table — but it is reported rather than
 * swallowed, because a silently empty category column looks like every plugin is uncategorized.
 */
import { readFileSync } from 'node:fs'

import { fetchJson } from '../util/http.js'

/**
 * @param {string} source - URL or filesystem path to a catalog snapshot.
 * @returns {Promise<Map<string, {category?: string, added?: string}>>}
 */
export async function loadCatalogCategories(source) {
  const document = /^https?:\/\//u.test(source)
    ? await fetchJson(source)
    : JSON.parse(readFileSync(source, 'utf8'))
  const entries = Array.isArray(document?.plugins) ? document.plugins : []
  const byPackage = new Map()
  for (const entry of entries) {
    // The catalog keys plugins by repository, but the compatibility matrix keys them by npm package
    // name, so the join has to go through the `npm` field.
    const name = typeof entry?.npm === 'string' ? entry.npm : undefined
    if (name === undefined) continue
    byPackage.set(name, {
      ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
      ...(typeof entry.added === 'string' ? { added: entry.added } : {}),
    })
  }
  return byPackage
}