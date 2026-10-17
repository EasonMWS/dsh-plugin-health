/**
 * Build a plugin market index in the official format 1, validated by the published
 * `@deepseek-ai/dsh-plugin-market-index` parser (the same rule set the DSH Host uses).
 * @module index/build
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { fetchJson, mapLimit } from '../util/http.js'
import { compatibilityLookup, loadCatalog, npmEntries } from './catalog.js'

const MARKET_TITLE = { en: 'DSH Plugin Health Index', zh: 'DSH 插件健康索引' }
const MARKET_DESCRIPTION = {
  en: 'Community DSH plugins with observed popularity and DSH compatibility data. Inclusion is not a security review.',
  zh: '带热度与 DSH 兼容性数据的社区插件。收录不代表安全背书。',
}

/** Labels every built index declares. */
const LABELS = {
  npm: { title: { en: 'npm package', zh: 'npm 包' } },
  compatible: { title: { en: 'compatible', zh: '兼容' } },
  incompatible: { title: { en: 'incompatible', zh: '不兼容' } },
  unchecked: { title: { en: 'compatibility unverified', zh: '兼容未验证' } },
  risk: { title: { en: 'capability risk', zh: '能力风险' } },
}

const SORT_KEYS = {
  downloads: { title: { en: 'Downloads', zh: '下载量' }, order: 'desc' },
  stars: { title: { en: 'Stars', zh: 'Star 数' }, order: 'desc' },
  health: { title: { en: 'Health score', zh: '健康分' }, order: 'desc' },
}

/**
 * Normalise localised text from a catalog or manifest, requiring an English fallback.
 * @param {unknown} value - string or localisation object.
 * @returns {string|Record<string,string>|undefined} format-1 LocalizedText.
 */
export function normalizeLocalized(value) {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(([language, text]) => (
    typeof text === 'string' && text.trim() !== '' && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u.test(language)
  ))
  if (entries.length === 0) return undefined
  const localized = Object.fromEntries(entries)
  if (!Object.hasOwn(localized, 'en')) localized.en = entries.find(([, text]) => text.trim() !== '')?.[1]
  return localized.en === undefined ? undefined : localized
}

/**
 * Normalise a repository reference into a format-1 repository object.
 * @param {object} manifest - package.json.
 * @param {object} entry - catalog entry.
 * @returns {{url: string, directory?: string}|undefined}
 */
export function normalizeRepository(manifest, entry) {
  const source = manifest?.repository
  const raw = typeof source === 'string' ? source : (source !== null && typeof source === 'object' ? source.url : undefined)
  const directory = typeof source === 'object' && source !== null && typeof source.directory === 'string' && source.directory !== ''
    ? source.directory
    : undefined
  const candidate = normalizeRepoUrl(typeof raw === 'string' ? raw : entry?.url)
  if (candidate === undefined) return undefined
  return directory === undefined ? { url: candidate } : { url: candidate, directory }
}

function normalizeRepoUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let text = value.trim().replace(/^git\+/, '')
  const tree = text.indexOf('/tree/')
  if (tree >= 0) text = text.slice(0, tree)
  text = text.replace(/\.git$/, '').replace(/[?#].*$/, '')
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function normalizeHomepage(manifest) {
  const value = manifest?.homepage
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Deterministic 0-100 health score: popularity with a capability-risk penalty and a compatibility bonus.
 * @param {{downloads?: number, stars?: number, compatible?: boolean, risk?: boolean}} facts - observed facts.
 * @returns {number} integer score.
 */
export function healthScore({ downloads = 0, stars = 0, compatible, risk = false }) {
  const downloadScore = Math.min(1, Math.log10(Math.max(0, Number(downloads) || 0) + 1) / 7)
  const starScore = Math.min(1, Math.log10(Math.max(0, Number(stars) || 0) + 1) / 5)
  let score = Math.round(downloadScore * 55 + starScore * 25)
  if (risk) score -= 10
  if (compatible === false) score -= 20
  if (compatible === true) score += 10
  return Math.max(0, Math.min(100, score))
}

/**
 * Choose the versions a format-1 entry lists: the dist-tag latest first, then the highest versions.
 * @param {any} packument - npm packument.
 * @param {number} maxVersions - maximum versions to list.
 * @returns {Array<{version: string, publishTimestamp: number, source: {type: 'npm'}, engines?: {dsh?: string}}>}
 */
export function selectedVersions(packument, maxVersions = 3) {
  const versions = packument?.versions ?? {}
  const times = packument?.time ?? {}
  const latest = packument?.['dist-tags']?.latest
  const ordered = Object.keys(versions)
    .filter((version) => semver.valid(version) !== null)
    .sort((left, right) => semver.rcompare(left, right))
  if (typeof latest === 'string' && ordered.includes(latest)) {
    ordered.splice(ordered.indexOf(latest), 1)
    ordered.unshift(latest)
  }
  const result = []
  for (const version of ordered) {
    if (result.length >= Math.max(1, maxVersions)) break
    const published = times[version]
    const milliseconds = typeof published === 'string' ? Date.parse(published) : Number.NaN
    if (!Number.isFinite(milliseconds)) continue
    const publishTimestamp = Math.floor(milliseconds / 1000)
    if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) continue
    const manifest = versions[version]
    const range = manifest?.engines?.dsh
    const engines = typeof range === 'string' && range !== '' && semver.validRange(range) !== null ? { dsh: range } : undefined
    result.push({ version, publishTimestamp, source: { type: 'npm' }, ...(engines === undefined ? {} : { engines }) })
  }
  return result
}

/**
 * Build the format-1 plugin document for one catalog entry.
 * @param {object} entry - catalog entry with an npm package name.
 * @param {{registry: string, maxVersions: number, loadPackument: Function, compatibleOf: Function, categories: object}} options
 * @returns {Promise<object|null>} plugin entry, or null when no publishable version exists.
 */
export async function buildPluginEntry(entry, { registry, maxVersions, loadPackument, compatibleOf, categories }) {
  const packument = await loadPackument(registry, entry.npm)
  const versions = selectedVersions(packument, maxVersions)
  if (versions.length === 0) return null
  const latest = packument?.versions?.[packument?.['dist-tags']?.latest] ?? packument?.versions?.[versions[0].version]
  const description = normalizeLocalized(entry.description) ?? normalizeLocalized(latest?.description)
  const repository = normalizeRepository(latest, entry)
  const homepage = normalizeHomepage(latest)
  const category = typeof entry.category === 'string' && Object.hasOwn(categories, entry.category) ? entry.category : undefined
  const compatible = compatibleOf(entry.npm)
  const risk = Array.isArray(entry.capabilityRedLines) && entry.capabilityRedLines.length > 0
  const labels = ['npm']
  if (compatible === true) labels.push('compatible')
  else if (compatible === false) labels.push('incompatible')
  else labels.push('unchecked')
  if (risk) labels.push('risk')
  const downloads = Number(entry.downloads) || 0
  const stars = Number(entry.stars) || 0
  return {
    name: entry.npm,
    ...(description === undefined ? {} : { description }),
    ...(typeof entry.owner === 'string' && entry.owner !== '' ? { author: entry.owner } : {}),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    metadata: {
      ...(category === undefined ? {} : { category }),
      labels,
      sortKeys: {
        downloads,
        stars,
        health: healthScore({ downloads, stars, compatible, risk }),
      },
    },
    versions,
  }
}

/**
 * Build a complete validated format-1 index.
 * @param {{
 *   catalog: string,
 *   hostVersion: string,
 *   indexUrl: string,
 *   limit?: number,
 *   sort?: 'downloads'|'stars'|'health',
 *   maxVersions?: number,
 *   registry?: string,
 *   concurrency?: number,
 *   matrix?: object,
 *   loadPackument?: Function,
 * }} options
 * @returns {Promise<{doc: object, stats: object, warnings: string[], validation: object}>}
 */
export async function buildFormat1Index({
  catalog, hostVersion, indexUrl, limit = 200, sort = 'downloads', maxVersions = 3,
  registry = 'https://registry.npmjs.org', concurrency = 8, matrix, loadPackument,
}) {
  const loaded = classifyCatalog(await loadCatalog(catalog))
  const compatibleOf = compatibilityLookup(matrix, hostVersion)
  const categories = Object.fromEntries(Object.entries(loaded.categories)
    .filter(([id, value]) => id !== '' && value !== null && typeof value === 'object')
    .map(([id, value]) => [id, { title: normalizeLocalized(value) }])
    .filter(([, value]) => value.title !== undefined))
  const candidates = npmEntries(loaded.entries)
  const sorted = [...candidates].sort((left, right) => {
    if (sort === 'stars') return (Number(right.stars) || 0) - (Number(left.stars) || 0)
    return (Number(right.downloads) || 0) - (Number(left.downloads) || 0)
  })
  const chosen = sorted.slice(0, Math.max(1, limit))
  const warnings = []
  const looked = await mapLimit(chosen, concurrency, async (entry) => {
    try {
      return await buildPluginEntry(entry, {
        registry, maxVersions, loadPackument: loadPackument ?? defaultLoadPackument, compatibleOf, categories,
      })
    } catch (error) {
      warnings.push(`${entry.npm}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  })
  const plugins = looked.filter((plugin) => plugin !== null)
  const doc = {
    format: 1,
    title: MARKET_TITLE,
    description: MARKET_DESCRIPTION,
    metadata: {
      ...(Object.keys(categories).length === 0 ? {} : { categories }),
      labels: LABELS,
      sortKeys: SORT_KEYS,
    },
    plugins,
  }
  const parsed = parseMarketIndex(doc, indexUrl)
  const stats = {
    generatedAt: new Date().toISOString(),
    hostVersion,
    indexUrl,
    catalog: loaded.meta,
    catalogEntries: loaded.entries.length,
    npmEntries: candidates.length,
    gitOnlySkipped: loaded.entries.length - candidates.length,
    included: plugins.length,
    failed: chosen.length - plugins.length,
    versions: plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0),
    bytes: Buffer.byteLength(JSON.stringify(doc)),
    sort,
    limit,
    maxVersions,
    byCategory: countBy(plugins, (plugin) => plugin.metadata.category ?? '(none)'),
    byLabel: countBy(plugins, (plugin) => plugin.metadata.labels.join('+')),
  }
  return { doc, stats, warnings, validation: { plugins: parsed.plugins.length, title: parsed.title } }
}

function defaultLoadPackument(registry, name) {
  return fetchJson(`${registry.replace(/\/$/, '')}/${name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name)}`)
}

function classifyCatalog(loaded) {
  return loaded
}

function countBy(items, keyOf) {
  const counts = {}
  for (const item of items) {
    const key = keyOf(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Write an index and its build report.
 * @param {{doc: object, stats: object, warnings: string[]}} build - output of `buildFormat1Index`.
 * @param {string} outDir - destination directory.
 * @returns {{index: string, report: string}} written files.
 */
export function writeIndex(build, outDir) {
  mkdirSync(outDir, { recursive: true })
  const index = join(outDir, 'index.json')
  const report = join(outDir, 'build-report.md')
  writeFileSync(index, `${JSON.stringify(build.doc, null, 0)}\n`)
  const lines = [
    '# DSH format-1 index build report',
    '',
    `- Generated at: ${build.stats.generatedAt}`,
    `- Host label: ${build.stats.hostVersion}`,
    `- Index URL: ${build.stats.indexUrl}`,
    `- Catalog: ${build.stats.catalog?.url ?? build.stats.catalog?.name ?? 'unknown'} (declared ${build.stats.catalog?.declaredCount ?? '?'})`,
    `- Catalog entries: ${build.stats.catalogEntries}; npm entries: ${build.stats.npmEntries}; GitHub/tarball-only skipped: ${build.stats.gitOnlySkipped}`,
    `- Included plugins: ${build.stats.included}; failed: ${build.stats.failed}; versions: ${build.stats.versions}`,
    `- Output size: ${build.stats.bytes} bytes`,
    '',
    '## Category counts',
    '',
    ...Object.entries(build.stats.byCategory).sort((left, right) => right[1] - left[1]).map(([category, count]) => `- ${category}: ${count}`),
    '',
    '## Label counts',
    '',
    ...Object.entries(build.stats.byLabel).sort((left, right) => right[1] - left[1]).map(([label, count]) => `- ${label}: ${count}`),
    '',
    ...(build.warnings.length === 0 ? [] : ['## Warnings', '', ...build.warnings.map((warning) => `- ${warning}`), '']),
  ]
  writeFileSync(report, lines.join('\n'))
  return { index, report }
}
