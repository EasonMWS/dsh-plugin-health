/**
 * Small HTTP helpers shared by the matrix and index commands.
 * @module util/http
 */

const USER_AGENT = 'dsh-plugin-health/0.1.0 (+https://github.com/)'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/**
 * Encode a package name for the npm registry path, keeping the scope separator escaped.
 * @param {string} name - npm package name.
 * @returns {string} path-safe package name.
 */
export function encodePackageName(name) {
  return name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name)
}

/**
 * Fetch and parse one JSON document with a bounded timeout and retries.
 * @param {string} url - absolute URL.
 * @param {{timeoutMs?: number, retries?: number, headers?: Record<string,string>}} [options]
 * @returns {Promise<any>} parsed JSON.
 */
export async function fetchJson(url, { timeoutMs = 30_000, retries = 2, headers = {} } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
        signal: controller.signal,
      })
      if (response.status === 404) {
        const error = new Error(`not found: ${url}`)
        error.status = 404
        throw error
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (error.status === 404) throw error
      if (attempt === retries) break
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Run an async mapper with a bounded number of concurrent workers, preserving input order.
 * @template T, R
 * @param {readonly T[]} items - inputs.
 * @param {number} limit - maximum in-flight calls.
 * @param {(item: T, index: number) => Promise<R>} mapper - async worker.
 * @returns {Promise<R[]>} results in input order.
 */
export async function mapLimit(items, limit, mapper) {
  const size = Math.max(1, Math.floor(limit) || 1)
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Load one packument from the npm registry.
 * @param {string} registry - registry origin, no trailing slash.
 * @param {string} name - package name.
 * @returns {Promise<any>} packument.
 */
export async function loadPackumentFromRegistry(registry, name) {
  return fetchJson(`${registry.replace(/\/$/, '')}/${encodePackageName(name)}`)
}

export { DEFAULT_REGISTRY }
