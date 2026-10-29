/**
 * Command-line interface for dsh-plugin-health.
 * @module cli
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_REGISTRY, fetchJson } from './util/http.js'
import { createMatrix, hostSummary } from './compat/matrix.js'
import { matrixToMarkdown, writeBadges } from './compat/report.js'
import { buildFormat1Index, writeIndex } from './index/build.js'
import { inspectDshHome, listInstalledPlugins, resolveDshHome } from './repair/inspect.js'
import { formatInspection } from './repair/format.js'
import { applyRepairs, planRepairs } from './repair/apply.js'
import { runRuntimeSmoke, resolvePluginIdentity } from './runtime/smoke.js'
import {
  auditRescues, declarationConflict, rehearse, rescuePlugin, undoRescue,
} from './rescue/rescue.js'
import { checkUpstream } from './rescue/upstream.js'
import { buildReport, findExistingReports, rememberReport, repositorySlug } from './rescue/reporting.js'
import { buildBrief, writeHandoff } from './rescue/handoff.js'
import { discoverDshDirectory, hostVersionOf } from './rescue/environment.js'
import { diagnoseBoot, enterSafeMode, restoreSafeMode } from './rescue/boot.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const BOOLEAN_OPTIONS = new Set([
  'json', 'help', 'version', 'apply', 'yes', 'force', 'badges', 'no-badges',
  'boot-only', 'bypass-gate', 'undo', 'status', 'no-rehearse',
])

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

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function collectPluginSpecs(options) {
  const values = [...allStrings(options, 'plugin'), ...allStrings(options, 'plugins')]
  const specs = []
  for (const value of values) {
    for (const part of value.split(',')) {
      const text = part.trim()
      if (text === '' || text.startsWith('#')) continue
      if (isFile(text)) specs.push(...readLines(text))
      else specs.push(text)
    }
  }
  return [...new Set(specs)]
}

function collectHosts(options) {
  const values = allStrings(options, 'versions')
  const hosts = []
  for (const value of values) {
    const parts = isFile(value) ? readLines(value) : value.split(',')
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
    '  dsh-plugin-health smoke --dsh-dir <dir> --plugin <spec|tarball> --tool <name> [options]',
    '  dsh-plugin-health index --catalog <file|url> --index-url <url> [options]',
    '  dsh-plugin-health doctor [--home <dir>] [--profile <name>] [--runtime <version>] [--json]',
    '  dsh-plugin-health repair [--home <dir>] [--profile <name>] [--runtime <version>] [--apply --yes]',
    '  dsh-plugin-health rescue --profile <name> --plugin <name@version> [--apply] [--undo] [--status]',
    '  dsh-plugin-health handoff --profile <name> --plugin <name@version>',
    '  dsh-plugin-health report --profile <name> --plugin <name@version>',
    '  dsh-plugin-health boot diagnose|safe|restore [--profile <name>] [--apply]',
    '',
    'boot options (the only commands that work when DSH itself will not start):',
    '  diagnose               explain why boot fails, from the logs the host left behind',
    '  safe                   disable every third-party entry so DSH starts again',
    '  restore                remove the safe-mode overlay, leaving your own patches alone',
    '  --apply                actually write; without it every boot action is a dry run',
    '  --profile <name>       profile to inspect (default: desktop)',
    '',
    'rescue options (rehearse a rejected plugin in a throwaway home, then exempt it if it boots):',
    '  --profile <name>       profile whose plugins and exemptions are used (required)',
    '  --plugin <name@version>  the exact installed version to rescue, undo, or describe',
    '  --apply                actually grant the exemption; without it the run is a dry run',
    '  --undo                 revoke exemptions granted by this tool and clear the ledger',
    '  --status               list recorded rescues and whether an upstream fix has landed',
    '  --dsh-dir <dir>        installed @deepseek-ai/dsh to rehearse against (auto-discovered)',
    '  --runtime <version>    host version to judge against (default: the installed host)',
    '  --timeout <ms>         boot timeout for the rehearsal',
    '  --install-timeout <ms> install timeout for the rehearsal',
    '',
    'handoff options:',
    '  --plugin <name@version>  write a brief + prompt for your own agent (nothing is sent)',
    '  --no-rehearse          skip the runtime rehearsal; write the brief from declarations only',
    '',
    'report options:',
    '  --plugin <name@version>  check for an existing upstream report, then draft one',
    '  --rehearsal <runs|broken>  include the runtime verdict in the drafted text',
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
    'smoke options (executes plugin code in a fresh profile; not a security sandbox):',
    '  --dsh-dir <dir>        installed @deepseek-ai/dsh package directory (profile-boot export required)',
    '  --plugin <spec|tarball>  install using the official dsh plugin CLI',
    '  --tool <name>          assert tool registration after boot (repeatable)',
    '  --calls <file>         JSON array of {name, arguments, expectedValue?} tool calls',
    '  --boot-only            accept activation alone, for UI-only plugins with no tools',
    '  --bypass-gate          grant the exact-version exemption inside the throwaway test home only,',
    '                         so an incompatible plugin can be judged instead of merely rejected',
    '  --timeout <ms>         runtime timeout, including assertions and shutdown (default: 30000)',
    '  --install-timeout <ms> installation timeout (default: 120000)',
    '  --out <dir>            parent for retained run directories (default: OS temporary directory)',
    '  --json                 print report as JSON',
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

async function cmdSmoke(options) {
  const callsPath = lastString(options, 'calls')
  const bootOnly = booleanOption(options, 'boot-only')
  if (!lastString(options, 'dsh-dir') || !lastString(options, 'plugin') || (allStrings(options, 'tool').length === 0 && callsPath === undefined && !bootOnly)) {
    throw new UsageError('smoke requires --dsh-dir, --plugin, and at least one --tool or --calls assertion (or --boot-only)')
  }
  const report = await runRuntimeSmoke({
    dshDirectory: lastString(options, 'dsh-dir'),
    plugin: lastString(options, 'plugin'),
    tools: allStrings(options, 'tool'),
    calls: callsPath === undefined ? [] : JSON.parse(readFileSync(callsPath, 'utf8')),
    out: lastString(options, 'out'),
    bootOnly,
    bypassGate: booleanOption(options, 'bypass-gate'),
    timeoutMs: numberOption(options, 'timeout', 30000),
    installTimeoutMs: numberOption(options, 'install-timeout', 120000),
  })
  if (booleanOption(options, 'json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`smoke: ${report.ok ? 'passed' : 'failed'} (${report.plugin}, dsh ${report.hostVersion})`)
    for (const stage of report.stages) {
      console.log(`  ${stage.name}: ${stage.timedOut ? 'timed out' : stage.ok ? 'passed' : 'failed'}${stage.details?.stage ? ` (${stage.details.stage})` : ''}`)
      if (stage.details?.error) console.error(stage.details.error)
      if (stage.error) console.error(stage.error)
      if (!stage.ok && stage.stderr) console.error(stage.stderr)
    }
    if (report.error) console.error(report.error)
    console.log(`output: ${join(report.directory, 'smoke.json')}`)
  }
  return report.ok ? 0 : 1
}

function printFindings(result) {
  console.log(formatInspection(result))
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

/** Resolve the profile directory and running host version for rescue commands. */
function rescueContext(options) {
  const home = resolveDshHome(lastString(options, 'home'))
  const profile = lastString(options, 'profile')
  if (profile === undefined) throw new UsageError('rescue commands require --profile <name>')
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) throw new UsageError(`no such profile: ${profile} (looked in ${profileDir})`)
  const runtimeVersion = lastString(options, 'runtime') ?? hostVersionOf(profileDir, home)
  const dshDirectory = lastString(options, 'dsh-dir') ?? discoverDshDirectory(home, profileDir)
  return { home, profile, profileDir, runtimeVersion, dshDirectory }
}

/** Read the installed version of a plugin from the profile, if present. */
function manifestReader(profileDir) {
  return (name) => {
    const direct = join(profileDir, 'node_modules', name, 'package.json')
    try {
      return JSON.parse(readFileSync(direct, 'utf8'))
    } catch {
      for (const candidate of listInstalledPlugins(profileDir)) {
        if (candidate.name !== name) continue
        try {
          return JSON.parse(readFileSync(join(candidate.directory, 'package.json'), 'utf8'))
        } catch { return undefined }
      }
      return undefined
    }
  }
}

const RESCUE_OUTCOME_TEXT = {
  runs: 'the plugin installs and boots on this host once the requirement is exempted',
  broken: 'the plugin still fails to boot on this host even with the requirement exempted',
  inconclusive: 'the isolated rehearsal could not reach a verdict (install or exemption failed)',
}

async function cmdRescue(options) {
  const context = rescueContext(options)
  if (context.dshDirectory === undefined) {
    throw new UsageError('rescue needs an installed @deepseek-ai/dsh; pass --dsh-dir <dir> or install it somewhere reachable')
  }
  const plugin = lastString(options, 'plugin')
  if (plugin === undefined) throw new UsageError('rescue requires --plugin <name@version>')
  const dryRun = !booleanOption(options, 'apply')
  const result = await rescuePlugin({
    profileDir: context.profileDir,
    dshDirectory: context.dshDirectory,
    plugin,
    runtimeVersion: context.runtimeVersion,
    profile: context.profile,
    dryRun,
    timeoutMs: numberOption(options, 'timeout', 120000),
    installTimeoutMs: numberOption(options, 'install-timeout', 300000),
    out: lastString(options, 'out'),
  })
  if (booleanOption(options, 'json')) { console.log(JSON.stringify(result, null, 2)); return result.applied || result.wouldApply ? 0 : 1 }
  const { name, version } = result.plugin
  console.log(`rescue ${name}@${version} on dsh ${result.runtimeVersion} (profile ${result.profile})`)
  console.log(`  rehearsal: ${result.verdict} — ${RESCUE_OUTCOME_TEXT[result.verdict]}`)
  if (result.rehearsal?.directory) console.log(`  evidence:  ${result.rehearsal.directory}`)
  if (result.verdict !== 'runs') {
    console.log('\nnothing was changed. A declaration exemption would not have made this plugin work.')
    console.log('run "dsh-plugin-health handoff --plugin ' + `${name}@${version}" to prepare an AI brief, or report it upstream.`)
    return 1
  }
  if (result.wouldApply) {
    console.log('\ndry run; nothing changed. Re-run with --apply to grant the exemption in this profile.')
    console.log('it is recorded and can be removed with: dsh-plugin-health rescue --profile ' + context.profile + ' --undo')
    return 0
  }
  console.log(`  applied:   exemption granted for ${result.entry.key} on ${context.runtimeVersion}`)
  console.log('  undo with: dsh-plugin-health rescue --profile ' + context.profile + ' --undo')
  return 0
}

async function cmdRescueStatus(options) {
  const context = rescueContext(options)
  const audits = auditRescues(context.profileDir, {
    readManifest: manifestReader(context.profileDir),
    runtimeVersion: context.runtimeVersion,
  })
  if (audits.length === 0) {
    if (booleanOption(options, 'json')) console.log('[]')
    else console.log('no rescues recorded for this profile')
    return 0
  }
  const upstream = await checkUpstream({
    entries: audits.filter(entry => entry.active),
    profileDir: context.profileDir,
    runtimeVersion: context.runtimeVersion,
  })
  const merged = audits.map((entry) => {
    const found = upstream.find(item => item.key === entry.key)
    return found === undefined ? entry : { ...entry, upstream: found.status, target: found.target }
  })
  if (booleanOption(options, 'json')) { console.log(JSON.stringify(merged, null, 2)); return 0 }
  console.log(`rescued plugins in profile ${context.profile} (dsh ${context.runtimeVersion}):`)
  for (const entry of merged) {
    const state = entry.active ? 'active' : 'revoked'
    const upstreamText = entry.upstream === 'fix-available'
      ? `upstream has a fix: ${entry.target?.fixed ?? '?'} — upgrade, then undo the exemption`
      : entry.upstream === 'newer-but-still-incompatible'
        ? `newer version ${entry.target?.latest} exists but still rejects this host`
        : entry.upstream === 'unknown' ? 'upstream check failed' : 'no upstream fix yet'
    console.log(`  ${entry.key} on ${entry.runtimeVersion}: ${state}; ${upstreamText}`)
  }
  return 0
}

function cmdRescueUndo(options) {
  const context = rescueContext(options)
  const key = lastString(options, 'plugin')
  const { undone, remaining } = undoRescue(context.profileDir, key === undefined ? {} : { key })
  if (booleanOption(options, 'json')) { console.log(JSON.stringify({ undone, remaining }, null, 2)); return 0 }
  if (undone.length === 0) { console.log('nothing to undo for this profile'); return 0 }
  for (const entry of undone) console.log(`  revoked ${entry.key} on ${entry.runtimeVersion}`)
  console.log(`${undone.length} rescue(s) revoked; ${remaining.length} still recorded`)
  return 0
}

async function cmdHandoff(options) {
  const context = rescueContext(options)
  const plugin = lastString(options, 'plugin')
  if (plugin === undefined) throw new UsageError('handoff requires --plugin <name@version>')
  const identity = resolvePluginIdentity(plugin)
  const readManifest = manifestReader(context.profileDir)
  const manifest = readManifest(identity.name)
  if (manifest === undefined) throw new UsageError(`plugin is not installed in profile ${context.profile}: ${identity.name}`)
  const conflict = declarationConflict(manifest, context.runtimeVersion)
  let smokeReport
  if (context.dshDirectory !== undefined && !booleanOption(options, 'no-rehearse')) {
    const rehearsal = await rehearse({
      dshDirectory: context.dshDirectory,
      plugin: `${identity.name}@${identity.version}`,
      runtimeVersion: context.runtimeVersion,
      timeoutMs: numberOption(options, 'timeout', 120000),
      installTimeoutMs: numberOption(options, 'install-timeout', 300000),
      out: lastString(options, 'out'),
    })
    smokeReport = rehearsal.report
  }
  const brief = buildBrief({
    name: identity.name,
    version: identity.version,
    runtimeVersion: context.runtimeVersion,
    requirements: conflict.requirements,
    installedManifest: manifest,
    smokeReport,
    repositoryUrl: repositorySlug(manifest) === undefined ? undefined : `https://github.com/${repositorySlug(manifest)}`,
    toolVersion: VERSION,
  })
  const written = writeHandoff(context.profileDir, brief, smokeReport)
  if (booleanOption(options, 'json')) { console.log(JSON.stringify({ ...written, brief }, null, 2)); return 0 }
  console.log(`prepared an AI brief for ${identity.name}@${identity.version} (nothing was sent)`)
  for (const file of written.files) console.log(`  ${file}`)
  console.log('\nThe prompt is ready to paste into your own agent. This tool never calls a model and never')
  console.log('spends your tokens; sending it is entirely your decision. Copy it from:')
  console.log(`  ${join(written.directory, 'prompt.md')}`)
  return 0
}

async function cmdReport(options) {
  const context = rescueContext(options)
  const plugin = lastString(options, 'plugin')
  if (plugin === undefined) throw new UsageError('report requires --plugin <name@version>')
  const identity = resolvePluginIdentity(plugin)
  const manifest = manifestReader(context.profileDir)(identity.name)
  if (manifest === undefined) throw new UsageError(`plugin is not installed in profile ${context.profile}: ${identity.name}`)
  const slug = repositorySlug(manifest)
  if (slug === undefined) throw new UsageError(`cannot work out a GitHub repository for ${identity.name}; open the issue manually`)
  console.log(`checking whether ${slug} already has a report for ${identity.name} on dsh ${context.runtimeVersion} ...`)
  const existing = await findExistingReports({
    slug, name: identity.name, runtimeVersion: context.runtimeVersion,
    token: process.env.GITHUB_TOKEN,
  })
  if (!existing.checked) console.log(`  could not check GitHub (${existing.error}); the text below is still prepared`)
  else if (existing.existing.length > 0) {
    console.log(`  ${existing.existing.length} existing report(s) found — add to one of these instead of filing a duplicate:`)
    for (const item of existing.existing) console.log(`    #${item.number} [${item.state}] ${item.title}\n      ${item.url}`)
    return 0
  } else console.log('  no existing report found for this package and host version')
  const conflict = declarationConflict(manifest, context.runtimeVersion)
  const report = buildReport({
    name: identity.name,
    version: identity.version,
    runtimeVersion: context.runtimeVersion,
    requirements: conflict.requirements,
    rehearsal: lastString(options, 'rehearsal'),
    repositoryUrl: `https://github.com/${slug}`,
    toolVersion: VERSION,
  })
  rememberReport(context.profileDir, {
    name: identity.name, version: identity.version,
    runtimeVersion: context.runtimeVersion, slug, title: report.title,
  })
  const target = `https://github.com/${slug}/issues/new`
  console.log(`\nprepared a report for ${slug} (nothing was filed):`)
  console.log(`  open: ${target}`)
  console.log(`  title: ${report.title}`)
  if (booleanOption(options, 'json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log('\n--- body ---')
    console.log(report.body)
  }
  console.log('\nThis tool does not file issues for you. Review, then paste it into the link above.')
  return 0
}

/**
 * Boot guard. This is the only command group that still works when DSH itself cannot
 * start, which is why it never imports the UI or asks the host anything.
 * @param {Map<string, unknown[]>} options
 * @param {string[]} positionals - `boot <action>`; the action is the first positional.
 */
async function cmdBoot(options, positionals = []) {
  const home = resolveDshHome(lastString(options, 'home'))
  const profile = lastString(options, 'profile') ?? 'desktop'
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) throw new UsageError(`no such profile: ${profile} (looked in ${profileDir})`)
  const action = lastString(options, 'boot-action') ?? positionals[0] ?? 'diagnose'

  if (action === 'diagnose') {
    const diagnosis = diagnoseBoot({ profileDir })
    if (booleanOption(options, 'json')) {
      console.log(JSON.stringify({ profile, profileDir, ...diagnosis }, null, 2))
      return diagnosis.failures.length > 0 || diagnosis.patchInvalid ? 1 : 0
    }
    console.log(`boot diagnosis for profile ${profile}`)
    console.log(`  directory: ${profileDir}`)
    console.log(`  third-party entries: ${diagnosis.thirdParty.length}`)
    if (diagnosis.patchInvalid) console.log(`  ✗ ${diagnosis.patchInvalid ? 'patch layer cannot be parsed' : ''}`)
    if (diagnosis.failures.length === 0) {
      console.log('  no recognisable failure signature in the logs')
    } else {
      console.log('  failure signatures:')
      for (const failure of diagnosis.failures.slice(0, 8)) console.log(`    ✗ [${failure.kind}] ${failure.line}`)
    }
    for (const line of diagnosis.advice) console.log(`\n  ${line}`)
    console.log('\n  next: "boot safe --profile ' + profile + '" disables every third-party entry so DSH can start.')
    return 0
  }

  if (action === 'safe') {
    const dryRun = !booleanOption(options, 'apply')
    const result = enterSafeMode(profileDir, { dryRun })
    if (booleanOption(options, 'json')) { console.log(JSON.stringify(result, null, 2)); return 0 }
    if (!result.changed) { console.log(`nothing to disable: ${result.alreadyDisabled} entry(ies) already disabled`); return 0 }
    console.log(`${dryRun ? 'would disable' : 'disabled'} ${result.added.length} third-party entr(ies) in ${result.file}`)
    for (const entry of result.added) console.log(`  - ${entry.name ?? entry.id}`)
    if (dryRun) {
      console.log('\ndry run; nothing changed. Re-run with --apply to write the overlay.')
      console.log('reverse it at any time with: dsh-plugin-health boot restore --profile ' + profile + ' --apply')
    } else {
      console.log('\nnow start DSH. Re-enable plugins one at a time to find the culprit, then run:')
      console.log('  dsh-plugin-health boot restore --profile ' + profile + ' --apply')
    }
    return 0
  }

  if (action === 'restore') {
    const dryRun = !booleanOption(options, 'apply')
    const result = restoreSafeMode(profileDir, { dryRun })
    if (booleanOption(options, 'json')) { console.log(JSON.stringify(result, null, 2)); return 0 }
    if (result.removed === 0) { console.log('no safe-mode overlay found; nothing to restore'); return 0 }
    console.log(`${dryRun ? 'would remove' : 'removed'} ${result.removed} safe-mode entr(ies) from ${result.file}`)
    if (dryRun) console.log('\ndry run; nothing changed. Re-run with --apply to write the change.')
    return 0
  }

  throw new UsageError(`unknown boot action: ${action} (expected diagnose, safe, or restore)`)
}

/**
 * Run one CLI invocation.
 * @param {readonly string[]} argv - arguments without node/script.
 * @returns {Promise<number>} exit code.
 */
export async function main(argv) {
  const { command, options, positionals } = parseArgv(argv)
  if (command === 'help' || command === '-h' || command === '--help' || booleanOption(options, 'help')) {
    console.log(usage())
    return 0
  }
  if (command === 'version' || command === '--version' || booleanOption(options, 'version')) {
    console.log(VERSION)
    return 0
  }
  try {
    if (command === 'rescue' && booleanOption(options, 'undo')) return cmdRescueUndo(options)
    if (command === 'rescue' && booleanOption(options, 'status')) return await cmdRescueStatus(options)
    switch (command) {
      case 'matrix': return await cmdMatrix(options)
      case 'smoke': return await cmdSmoke(options)
      case 'index': return await cmdIndex(options)
      case 'doctor': return await cmdDoctor(options)
      case 'repair': return await cmdRepair(options)
      case 'rescue': return await cmdRescue(options)
      case 'handoff': return await cmdHandoff(options)
      case 'report': return await cmdReport(options)
      case 'boot': return await cmdBoot(options, positionals)
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
