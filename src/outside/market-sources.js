/**
 * The market sources the user has added.
 *
 * Kept on disk rather than in the page: the outside server listens on a random loopback port, so the
 * browser origin changes every launch and localStorage would forget the list each time.
 *
 * Deliberately a plain list of sources, not a cache of their contents. A market index is someone else's
 * data and goes stale; re-reading it on demand is the only way the compatibility verdict stays honest.
 * @module outside/market-sources
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stateDirectory, writeAtomically } from '../state/shared.js'

/** How many sources are worth keeping; more than this is not a list anyone reads. */
const MAX_SOURCES = 12

/** @param {string} home */
function sourcesPath(home) {
  return join(stateDirectory(home), 'market-sources.json')
}

/**
 * Read the saved sources.
 *
 * A malformed file yields an empty list rather than an error: the sources are a convenience, and refusing to
 * show the page because a preference file is broken would be the wrong trade.
 *
 * @param {string} home
 * @returns {Array<{url: string, label: string}>}
 */
export function listSources(home) {
  const path = sourcesPath(home)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.sources)) return []
    return parsed.sources
      .filter((row) => row !== null && typeof row === 'object' && typeof row.url === 'string' && row.url !== '')
      .slice(0, MAX_SOURCES)
      .map((row) => ({ url: row.url, label: typeof row.label === 'string' && row.label !== '' ? row.label : row.url }))
  } catch {
    return []
  }
}

/**
 * Add a source, replacing an existing entry with the same URL.
 *
 * @param {string} home
 * @param {{url: string, label?: string}} source
 * @returns {{ok: true, sources: Array<object>} | {ok: false, error: string}}
 */
export function addSource(home, { url, label }) {
  if (typeof url !== 'string' || url.trim() === '') return { ok: false, error: 'a source URL or path is required' }
  const trimmed = url.trim()
  // A source is only useful if it is a URL or a file that exists; anything else fails later with a worse
  // message, so it is refused here.
  const isUrl = /^https?:\/\//iu.test(trimmed)
  const isPath = !isUrl && existsSync(trimmed)
  if (!isUrl && !isPath) return { ok: false, error: `not a URL, and no such file: ${trimmed}` }

  const existing = listSources(home).filter((row) => row.url !== trimmed)
  const next = [
    { url: trimmed, label: typeof label === 'string' && label !== '' ? label : defaultLabel(trimmed) },
    ...existing,
  ].slice(0, MAX_SOURCES)

  try {
    mkdirSync(stateDirectory(home), { recursive: true })
    writeAtomically(sourcesPath(home), `${JSON.stringify({ schemaVersion: 1, sources: next }, null, 2)}\n`)
    return { ok: true, sources: next }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Remove a source by URL.
 * @param {string} home
 * @param {string} url
 * @returns {{ok: true, sources: Array<object>}}
 */
export function removeSource(home, url) {
  const next = listSources(home).filter((row) => row.url !== url)
  mkdirSync(stateDirectory(home), { recursive: true })
  writeAtomically(sourcesPath(home), `${JSON.stringify({ schemaVersion: 1, sources: next }, null, 2)}\n`)
  return { ok: true, sources: next }
}

/**
 * A short label for a source: the last path segment of a URL, or the file name.
 * @param {string} url
 */
function defaultLabel(url) {
  // Check for a filesystem path first. "D:\\x\\y" parses as a URL whose scheme is "d:", and treating it as
  // one produced a percent-encoded label that told the user nothing.
  const looksLikePath = /^[A-Za-z]:[\\/]/u.test(url) || url.startsWith('/') || url.startsWith('\\\\') || /^file:/iu.test(url)
  if (looksLikePath) {
    const parts = decodeURIComponent(url).split(/[\\/]/u).filter(Boolean)
    return parts.pop() ?? url
  }
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    return last === undefined || last === '' ? parsed.hostname : last
  } catch {
    const parts = url.split(/[\\/]/u).filter(Boolean)
    return parts.pop() ?? url
  }
}