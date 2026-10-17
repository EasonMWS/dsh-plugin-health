/**
 * Command-line interface for dsh-plugin-health.
 * @module cli
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_REGISTRY, fetchJson } from './util/http.js'
import { createMatrix, hostSummary } from './compat/matrix.js'
import { matrixToMarkdown, writeBadges } from './compat/report.js'
import { buildFormat1Index, writeIndex } from './index/build.js'
import { inspectDshHome } from './repair/inspect.js'
import { applyRepairs, planRepairs } from './repair/apply.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const BOOLEAN_OPTIONS = new Set(['json', 'help', 'version', 'apply', 'yes', 'force', 'badges', 'no-badges'])

/**
 * Parse command and `--option value` pairs.
 * @param {readonly string[]} argv - arguments without node/script.
 * @returns {{command: string, options: Map<string, unknown[]>, positionals: string[]}}
 */
export function parseArgv(argv) {
  const [command = 'help', ...rest] = argv
  const options = new Map()
  const positionals = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--') {
      positionals.push(...rest.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      let key
      let value
      if (equals >= 0) {
        key = token.slice(2, equals)
        value = token.slice(equals + 1)
      } else {
        key = token.slice(2)
        const next = rest[index + 1]
        if (!BOOLEAN_OPTIONS.has(key) && next !== undefined && !next.startsWith('--')) {
          value = next
          index += 1
        } else {
          value = true
        }
      }
      const bucket = options.get(key) ?? []
      bucket.push(value)
      options.set(key, bucket)
    } else {
      positionals.push(token)
    }
  }
  return { command, options, positionals }
}

const lastValue = (options, key) => options.get(key)?.at(-1)
const lastString = (options, key) => {
  const value = lastValue(options, key)
  return typeof value === 'string' ? value : undefined
}
const allStrings = (options, key) => (options.get(key) ?? []).filter((value) => typeof value === 'string')
const booleanOption = (options, key) => {
  const value = lastValue(options, key)
  return value !== undefined && value !== 'false' && value !== ''
}
const numberOption = (options, key, fallback) => {
  const value = lastString(options, key)
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${key} must be a positive number`)
  return number
}

function readLines(filename) {
  return readFileSync(filename, 'utf8').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
}

function collectPluginSpecs(options) {
  const values = [...allStrings(options, 'plugin'), ...allStrings(options, 'plugins')]
  const specs = []
  for (const value of values) {
    for (const part of value.split(',')) {
      const text = part.trim()
      if (text === '' || text.startsWith('#')) continue
      if (existsSync(text)) specs.push(...readLines(text))
      else specs.push(text)
    }
  }
  return [...new Set(specs)]
}

function collectHosts(options) {
  const values = allStrings(options, 'versions')
  const hosts = []
  for (const value of values) {
    const parts = existsSync(value) ? readLines(value) : value.split(',')
    for (const part of parts) {
      const text = part.trim()
      if (text !== '' && !text.startsWith('#')) hosts.push(text)
    }
  }
  return hosts.length > 0 ? [...new Set(hosts)] : ['latest']
}

/**
 * Print the usage text.
 * @returns {string} help text.
 */
export function usage() {
  return [
    `dsh-plugin-health ${VERSION}`,
    '',
    'Usage:',
    '  dsh-plugin-health matrix --plugins <file|specs> [options]',
    '  dsh-plugin-health index --catalog <file|url> --index-url <url> [options]',
    '  dsh-plugin-health doctor [--home <dir>] [--profile <name>] [--runtime <version>] [--json]',
    '  dsh-plugin-health repair [--home <dir>] [--profile <name>] [--runtime <version>] [--apply --yes]',
    '',
    'matrix options:',
    '  --plugins <file|a,b>   plugin specs: npm name, name@version, or local directory (repeatable)',
    '  --versions <list>      host versions or dist-tags (default: latest; file or comma list)',
    '  --exemptions <file>    JSON map of "name@version" to exempted runtime versions',
    '  --out <dir>            output directory (default: dsh-health-out/matrix)',
    '  --fail-on <any|none|host>  exit 1 when the selected host(s) have incompatibilities',
    '  --no-badges            skip static SVG badges',
    '  --json                 also print the matrix JSON to stdout',
    '  --registry <url>       npm registry (default: https://registry.npmjs.org)',
    '  --concurrency <n>      network concurrency (default: 6)',
    '',
    'index options:',
    '  --catalog <file|url>   awesome-dsh-plugin snapshot (default: awesome-dsh-plugin.com)',
    '  --index-url <url>      final public URL of index.json (required for validation)',
    '  --host <version>       host label for compatibility labels (default: npm latest)',
    '  --matrix <file>        matrix JSON from the matrix command, adds compatible/incompatible labels',
    '  --limit <n>            plugin count (default: 200)',
    '  --sort <downloads|stars>  catalog order before the limit (default: downloads)',
    '  --max-versions <n>     versions listed per plugin (default: 3)',
    '  --out <dir>            output directory (default: site)',
    '  --registry <url>       npm registry (default: https://registry.npmjs.org)',
    '  --concurrency <n>      network concurrency (default: 8)',
    '',
    'repair options:',
    '  --home <dir>           DSH home (default: DSH_HOME or ~/.dsh)',
    '  --profile <name>       profile (default: desktop, then web, then the first)',
    '  --quarantine <dir>     quarantine directory (default: <home>/.plugin-health/quarantine/<time>)',
    '  --apply --yes          actually move files / rewrite the patch (default: dry run)',
    '',
    'Exit codes: 0 ok, 1 diagnostics/CI failure, 2 usage error.',
  ].join('\n')
}

async function cmdMatrix(options) {
  const plugins = collectPluginSpecs(options)
  if (plugins.length === 0) throw new UsageError('matrix requires --plugins <file|specs>')
  const hosts = collectHosts(options)
  const registry = lastString(options, 'registry') ?? DEFAULT_REGISTRY
  const concurrency = numberOption(options, 'concurrency', 6)
  const exemptionsPath = lastString(options, 'exemptions')
  const exemptions = exemptionsPath === undefined ? {} : JSON.parse(readFileSync(exemptionsPath, 'utf8'))
  const out = lastString(options, 'out') ?? 'dsh-health-out/matrix'
  const matrix = await createMatrix({ plugins, hosts, exemptions, registry, concurrency })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`)
  writeFileSync(join(out, 'matrix.md'), matrixToMarkdown(matrix))
  const badges = booleanOption(options, 'no-badges') ? undefined : writeBadges(matrix, out)
  const summary = hostSummary(matrix)
  console.log(`matrix: ${matrix.plugins.length} plugin(s) × ${matrix.hosts.length} host version(s)`)
  for (const row of summary) {
    console.log(`  dsh ${row.host}: ${row.compatible}/${row.total} compatible, ${row.incompatible} incompatible, ${row.errors} errors`)
  }
  for (const plugin of matrix.plugins) {
    const failures = Object.entries(plugin.results).filter(([, result]) => result.compatible === false)
    if (failures.length > 0) {
      console.log(`  ✗ ${plugin.name}@${plugin.version}: ${failures.map(([host, result]) => `${host} (${Object.keys(result.requirements).join(', ')})`).join('; ')}`)
    }
  }
  console.log(`output: ${join(out, 'matrix.json')}, ${join(out, 'matrix.md')}${badges === undefined ? '' : `, ${badges.files.length} badges`}`)
  if (booleanOption(options, 'json')) console.log(JSON.stringify(matrix, null, 2))
  const failOn = lastString(options, 'fail-on') ?? 'none'
  if (failOn !== 'none') {
    if (failOn !== 'any' && !matrix.hosts.includes(failOn)) throw new UsageError(`--fail-on host ${failOn} is not in ${matrix.hosts.join(', ')}`)
    const selected = failOn === 'any' ? summary : summary.filter((row) => row.host === failOn)
    if (selected.some((row) => row.incompatible > 0 || row.errors > 0)) return 1
  }
  return 0
}

async function cmdIndex(options) {
  const catalog = lastString(options, 'catalog') ?? 'https://awesome-dsh-plugin.com/plugins.json'
  const indexUrl = lastString(options, 'index-url') ?? 'https://example.com/index.json'
  if (/example\.com/u.test(indexUrl)) {
    console.warn('warning: --index-url still points at example.com; pass the final public URL of index.json.')
  }
  const registry = lastString(options, 'registry') ?? DEFAULT_REGISTRY
  const hostVersion = lastString(options, 'host') ?? await resolveLatestHost(registry)
  const limit = numberOption(options, 'limit', 200)
  const maxVersions = numberOption(options, 'max-versions', 3)
  const sort = lastString(options, 'sort') ?? 'downloads'
  if (!['downloads', 'stars', 'health'].includes(sort)) throw new UsageError('--sort must be downloads, stars, or health')
  const out = lastString(options, 'out') ?? 'site'
  const concurrency = numberOption(options, 'concurrency', 8)
  const matrixPath = lastString(options, 'matrix')
  const matrix = matrixPath === undefined ? undefined : JSON.parse(readFileSync(matrixPath, 'utf8'))
  const build = await buildFormat1Index({ catalog, hostVersion, indexUrl, limit, sort, maxVersions, registry, concurrency, matrix })
  const files = writeIndex(build, out)
  console.log(`index: ${build.stats.included} plugins, ${build.stats.versions} versions, ${build.stats.bytes} bytes (host ${build.stats.hostVersion})`)
  console.log(`  catalog: ${build.stats.catalogEntries} entries, npm: ${build.stats.npmEntries}, git/tarball-only skipped: ${build.stats.gitOnlySkipped}`)
  console.log(`  categories: ${Object.keys(build.stats.byCategory).length}, labels: ${Object.keys(build.stats.byLabel).length}`)
  console.log(`  validated by @deepseek-ai/dsh-plugin-market-index: ${build.validation.plugins} plugins`)
  console.log(`output: ${files.index}, ${files.report}`)
  if (build.warnings.length > 0) {
    console.warn(`warnings (${build.warnings.length}):`)
    for (const warning of build.warnings.slice(0, 20)) console.warn(`  - ${warning}`)
  }
  if (booleanOption(options, 'json')) console.log(JSON.stringify(build.stats, null, 2))
  return 0
}

async function resolveLatestHost(registry) {
  const packument = await fetchJson(`${registry.replace(/\/$/u, '')}/@deepseek-ai%2Fdsh`)
  const latest = packument?.['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error('cannot resolve the latest @deepseek-ai/dsh version from the registry')
  return latest
}

function printFindings(result) {
  console.log(`DSH home: ${result.home}`)
  console.log(`Profiles: ${result.profiles.length === 0 ? '(none)' : result.profiles.join(', ')}`)
  if (result.profile !== undefined) console.log(`Profile: ${result.profile} (${result.profileDir})`)
  for (const item of result.findings) {
    console.log(`\n[${item.severity}] ${item.id}: ${item.title}`)
    if (item.detail !== undefined) console.log(`  ${item.detail}`)
    if (item.fix?.description !== undefined) console.log(`  fix${item.fix.auto === true ? ' (auto)' : ''}: ${item.fix.description}`)
  }
  console.log(`\nSummary: ${result.summary.error} error(s), ${result.summary.warn} warning(s), ${result.summary.info} info; auto-fixable: ${result.summary.autoFixable}`)
}

async function cmdDoctor(options) {
  const result = inspectDshHome({
    home: lastString(options, 'home'),
    profile: lastString(options, 'profile'),
    runtimeVersion: lastString(options, 'runtime'),
  })
  if (booleanOption(options, 'json')) console.log(JSON.stringify(result, null, 2))
  else printFindings(result)
  return result.summary.error > 0 ? 1 : 0
}

async function cmdRepair(options) {
  const result = inspectDshHome({
    home: lastString(options, 'home'),
    profile: lastString(options, 'profile'),
    runtimeVersion: lastString(options, 'runtime'),
  })
  const plan = planRepairs(result.findings)
  console.log(`auto-fixable findings: ${plan.auto.length}; manual: ${plan.manual.length}`)
  for (const item of plan.auto) console.log(`  auto: ${item.id}: ${item.fix.description}`)
  for (const item of plan.manual) console.log(`  manual: ${item.id}: ${item.title}`)
  const apply = booleanOption(options, 'apply')
  if (!apply) {
    console.log('\ndry run; nothing changed. Re-run with --apply --yes to quarantine files or rewrite the patch (originals are backed up).')
    return 0
  }
  if (!booleanOption(options, 'yes')) throw new UsageError('repair --apply requires --yes')
  const applied = await applyRepairs(result.findings, {
    home: result.home,
    dryRun: false,
    quarantineDir: lastString(options, 'quarantine'),
  })
  console.log(`\napplied ${applied.actions.length} repair(s)`)
  for (const action of applied.actions) {
    if (action.kind === 'quarantine') console.log(`  - quarantined ${action.from} -> ${action.to}`)
    else console.log(`  - rewrote ${action.file} (backup ${action.backup})`)
  }
  if (applied.actions.length > 0) console.log(`quarantine: ${applied.quarantineDir}`)
  return 0
}

class UsageError extends Error {}

/**
 * Run one CLI invocation.
 * @param {readonly string[]} argv - arguments without node/script.
 * @returns {Promise<number>} exit code.
 */
export async function main(argv) {
  const { command, options } = parseArgv(argv)
  if (command === 'help' || command === '-h' || command === '--help' || booleanOption(options, 'help')) {
    console.log(usage())
    return 0
  }
  if (command === 'version' || command === '--version' || booleanOption(options, 'version')) {
    console.log(VERSION)
    return 0
  }
  try {
    switch (command) {
      case 'matrix': return await cmdMatrix(options)
      case 'index': return await cmdIndex(options)
      case 'doctor': return await cmdDoctor(options)
      case 'repair': return await cmdRepair(options)
      default:
        console.error(`unknown command: ${command}`)
        console.error(usage())
        return 2
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`)
      return 2
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

export { VERSION }
