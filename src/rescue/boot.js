/**
 * Boot guard: get DSH running again when a plugin stops it from starting.
 *
 * Everything else in this tool runs *inside* DSH, which is exactly the situation that
 * does not exist when a broken plugin prevents boot. So this module is deliberately
 * CLI-only and dependency-free: it reads the profile on disk, decides which entries are
 * suspects, and can disable them by writing a patch overlay — never by editing the
 * plugin or deleting anything.
 *
 * Two mechanisms, because they answer different questions:
 *
 *   - `diagnose` explains *why* boot fails, from the artifacts the host leaves behind
 *     and from static checks that do not need the host to run.
 *   - `safe` disables every third-party entry at once, so DSH starts even when the
 *     culprit is not identifiable. It is the blunt, always-works option.
 *
 * Both write only into the profile's own patch layer, which the host already treats as
 * user-owned config, and both record what they changed so `restore` is exact.
 * @module rescue/boot
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Marker so `restore` removes exactly the entries this tool added and nothing else. */
export const SAFE_MARKER = 'dsh-plugin-health-safe-mode'

/** How many recent pnpm operations to inspect when diagnosing an install failure. */
const LOG_TAIL = 5

/**
 * Read the profile patch layer as an array, tolerating a missing or empty file.
 * @param {string} profileDir
 * @returns {object[]}
 */
export function readProfilePatch(profileDir) {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) return []
  try {
    const parsed = parseYaml(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'object' && entry !== null) : []
  } catch (error) {
    const wrapped = new Error(`the profile patch layer is not valid YAML: ${error.message}`)
    wrapped.code = 'PATCH_INVALID'
    throw wrapped
  }
}

/**
 * List third-party entries: everything the host does not ship itself.
 *
 * This tool's *own* entry is excluded on purpose. Safe mode exists to get DSH running so the
 * user can reach the health panel; disabling ourselves in the same breath would remove the
 * only interface that explains what just happened. Host packages are excluded because they
 * are the reference — disabling one removes services every plugin depends on, which is the
 * opposite of a fix.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function thirdPartyEntries(entries) {
  return entries.filter((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (name === '') return false
    if (name.startsWith('@deepseek-ai/')) return false
    if (isSelf(name, id)) return false
    return true
  })
}

/** Our own package name, and the ids it is registered under in a profile patch layer. */
const SELF_NAME = 'dsh-plugin-health'
const SELF_IDS = new Set(['plugin-health', SELF_NAME])

/**
 * Whether an entry is this tool. Matches the package name as well as the ids we register
 * under, because a profile patch layer inserts us with the short id `plugin-health` while
 * `name` carries the full package name.
 * @param {string} name
 * @param {string} id
 */
export function isSelf(name, id) {
  return name === SELF_NAME || SELF_IDS.has(id) || id.startsWith('dsh-plugin-health')
}

/**
 * Where the desktop app writes its crash reports.
 *
 * This is the only place the host records *why* it failed to start: the CLI prints to stderr
 * and exits, so nothing survives on disk there. The desktop app writes
 * `crash-<timestamp>-{host,renderer}.log` containing the phase, the app version and the error
 * text — which for a plugin failure names the offending package outright.
 * @returns {string|null}
 */
export function crashLogDirectory(env = process.env) {
  const appData = env.APPDATA ?? env.apdata
  if (typeof appData !== 'string' || appData === '') return null
  const directory = join(appData, '@deepseek-ai', 'dsh-desktop', 'logs')
  return existsSync(directory) ? directory : null
}

/**
 * Read the newest crash reports, newest first.
 * @param {{limit?: number, minBytes?: number, directory?: string|null, env?: object}} [options]
 * @returns {{path: string, at: number, name: string, text: string}[]}
 */
export function readCrashLogs({ limit = 3, directory, env } = {}) {
  const dir = directory === undefined ? crashLogDirectory(env) : directory
  if (dir === null || !existsSync(dir)) return []
  let files = []
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^crash-.*\.log$/u.test(entry.name))
      .map((entry) => {
        const path = join(dir, entry.name)
        let at = 0
        let size = 0
        try {
          const stats = statSync(path)
          at = stats.mtimeMs
          size = stats.size
        } catch {
          at = 0
        }
        return { path, at, size, name: entry.name }
      })
      // An empty crash file records that something died but not why; skip those.
      .filter(entry => entry.size > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  } catch {
    return []
  }
  return files.map((entry) => {
    let text = ''
    try { text = readFileSync(entry.path, 'utf8') } catch { text = '' }
    return { path: entry.path, at: entry.at, name: entry.name, text }
  })
}

/**
 * Pull the facts out of one crash report: what phase it died in, which app version, and the
 * error line. The error text is where a plugin name appears when a plugin is to blame.
 * @param {string} text
 * @returns {{phase?: string, app?: string, electron?: string, error?: string, pluginNames: string[]}}
 */
export function parseCrashReport(text) {
  if (typeof text !== 'string' || text === '') return { pluginNames: [] }
  const header = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-z][a-z ]*):\s*(.+)$/u)
    if (match) {
      const key = match[1].trim().toLowerCase()
      if (['phase', 'app', 'electron', 'node', 'platform', 'source', 'time'].includes(key) && header[key] === undefined) {
        header[key] = match[2].trim()
      }
    }
    if (line.startsWith('--- error ---')) break
  }
  const errorStart = text.indexOf('--- error ---')
  const errorBlock = errorStart === -1 ? '' : text.slice(errorStart + '--- error ---'.length)
  const error = errorBlock.split(/^---\s/mu)[0]?.trim().split('\n').slice(0, 6).join('\n') ?? ''
  // A plugin rejection names the package twice (skipping bundle "x" and Plugin x@1 is incompatible).
  const pluginNames = [...new Set(
    [...error.matchAll(/Plugin\s+(@?[\w.-]+(?:\/[\w.-]+)?)@([\w.+-]+)\s+is incompatible/gu)]
      .map(match => match[1]),
  )]
  return { ...header, error, pluginNames }
}

/**
 * Inspect the artifacts a failed boot leaves behind. Returns plain observations, not
 * conclusions: the caller decides how to present them.
 * @param {string} profileDir
 * @param {{maxLogs?: number, crashLogs?: {limit?: number, directory?: string|null, env?: object}}} [options]
 */
export function readBootEvidence(profileDir, { maxLogs = LOG_TAIL, crashLogs } = {}) {
  const logsDir = join(profileDir, '.plugin-manager', 'logs')
  const evidence = { operations: [], newestOperation: null, bootLog: null, crashes: [] }
  // Crash reports are the primary evidence when the host died during boot, so read them even
  // when the profile has no plugin-manager logs at all.
  evidence.crashes = readCrashLogs(crashLogs).map(log => ({ ...log, parsed: parseCrashReport(log.text) }))
  if (!existsSync(logsDir)) return evidence
  let operations = []
  try {
    operations = readdirSync(logsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const path = join(logsDir, entry.name)
        let at = 0
        try { at = statSync(path).mtimeMs } catch { at = 0 }
        return { name: entry.name, path, at }
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, maxLogs)
  } catch {
    return evidence
  }
  for (const operation of operations) {
    const logPath = join(operation.path, 'pnpm.log')
    let tail = ''
    try {
      const text = readFileSync(logPath, 'utf8')
      tail = text.slice(-4000)
    } catch {
      tail = ''
    }
    evidence.operations.push({ name: operation.name, at: operation.at, log: logPath, tail })
  }
  if (operations.length > 0) evidence.newestOperation = operations[0]
  // A boot that dies before the UI appears still writes its reason to the host log when
  // one is configured; check the usual places rather than assuming.
  for (const candidate of [join(profileDir, 'dsh.log'), join(profileDir, 'boot.log')]) {
    if (!existsSync(candidate)) continue
    try { evidence.bootLog = { path: candidate, tail: readFileSync(candidate, 'utf8').slice(-4000) } } catch { /* unreadable */ }
  }
  return evidence
}

/**
 * Look for the failure signatures the host prints when a plugin stops it booting.
 * @param {string} text
 * @returns {{kind: string, line: string}[]}
 */
export function detectBootFailures(text) {
  if (typeof text !== 'string' || text === '') return []
  const signatures = [
    { kind: 'failed-to-load', pattern: /plugin\(s\) failed to load/iu },
    { kind: 'patch-parse', pattern: /failed to parse patches|YAMLException/iu },
    { kind: 'missing-module', pattern: /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/iu },
    { kind: 'pnpm-install', pattern: /ERR_PNPM_[A-Z_]+/iu },
    { kind: 'peer-conflict', pattern: /unmet peer|peer dependency/iu },
    { kind: 'incompatible', pattern: /incompatible with dsh/iu },
  ]
  const found = []
  for (const line of text.split('\n')) {
    for (const signature of signatures) {
      if (signature.pattern.test(line)) {
        found.push({ kind: signature.kind, line: line.trim().slice(0, 300) })
        break
      }
    }
  }
  return found
}

/**
 * Build the diagnosis a person can act on.
 * @param {object} options
 * @returns {{thirdParty: object[], suspects: object[], failures: object[], culprit: string[], crashes: object[], patchInvalid: boolean, evidence: object, advice: string[]}}
 */
export function diagnoseBoot({ profileDir, crashLogs }) {
  const advice = []
  let entries = []
  let patchError
  try {
    entries = readProfilePatch(profileDir)
  } catch (error) {
    patchError = error.message
  }
  if (patchError !== undefined) {
    advice.push('The profile patch layer cannot be parsed, so DSH cannot start at all. '
      + 'Restore cordis.patch.yml from a backup, or run "safe" to rewrite it with only the managed entries.')
  }
  const thirdParty = thirdPartyEntries(entries)
  const evidence = readBootEvidence(profileDir, { crashLogs })
  const failures = []
  // A crash report is the strongest evidence available: the host wrote down what it was doing
  // and what went wrong. Read those first so the rest only fills gaps.
  const culprits = new Set()
  for (const crash of evidence.crashes) {
    failures.push(...detectBootFailures(crash.text))
    for (const name of crash.parsed.pluginNames) culprits.add(name)
  }
  for (const operation of evidence.operations) failures.push(...detectBootFailures(operation.tail))
  if (evidence.bootLog !== null) failures.push(...detectBootFailures(evidence.bootLog.tail))
  if (culprits.size > 0) {
    advice.push(`The host crash report names the plugin(s) that failed: ${[...culprits].join(', ')}. `
      + 'Disable those first — that is usually enough to boot again.')
  } else if (failures.length === 0 && thirdParty.length > 0) {
    advice.push(evidence.crashes.length > 0
      ? 'A crash report exists but names no plugin, so the cause is unclear. '
        + 'Run "safe" to disable third-party entries, then re-enable them one at a time.'
      : 'No crash report or recognisable failure signature was found. '
        + 'If DSH does not start, run "safe" to disable third-party entries, then re-enable them one at a time.')
  }
  return {
    thirdParty,
    suspects: thirdParty.filter(entry => typeof entry?.name === 'string'),
    culprit: [...culprits],
    crashes: evidence.crashes.map(crash => ({
      name: crash.name,
      at: crash.at,
      phase: crash.parsed.phase ?? null,
      app: crash.parsed.app ?? null,
      error: crash.parsed.error ?? '',
      pluginNames: crash.parsed.pluginNames,
    })),
    failures,
    patchInvalid: patchError !== undefined,
    evidence,
    advice,
  }
}

/**
 * Append a `disabled: true` overlay for every third-party entry, keeping anything the
 * user already wrote. The overlay targets entries by `id`, which is how the host's own
 * patch layer applies overrides.
 * @param {string} profileDir
 * @param {{dryRun?: boolean, now?: Date}} [options]
 */
export function enterSafeMode(profileDir, { dryRun = false, now = new Date() } = {}) {
  const path = join(profileDir, 'cordis.patch.yml')
  const entries = readProfilePatch(profileDir)
  const already = entries.filter(entry => entry?.disabled === true)
  // An entry is already handled when *any* overlay in this file disables it. Filtering on
  // `entry.disabled` alone would re-disable an entry that our previous run already
  // overlaid, so compare the set of ids that are already off.
  const disabledIds = new Set(already.map(entry => entry.id).filter(id => typeof id === 'string'))
  const targets = thirdPartyEntries(entries).filter(entry => {
    if (entry.disabled === true) return false
    return !(typeof entry.id === 'string' && disabledIds.has(entry.id))
  })
  if (targets.length === 0) return { changed: false, added: [], alreadyDisabled: already.length, file: path }
  const overlay = targets.map(entry => ({
    id: entry.id,
    // Repeating the name makes the override unambiguous for entries whose id the user
    // changed; the host matches on id first.
    ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
    disabled: true,
    comment: `${SAFE_MARKER}: disabled ${now.toISOString()} because DSH would not start. Remove with dsh-plugin-health boot restore.`,
  }))
  if (!dryRun) {
    const next = [...entries, ...overlay]
    writeFileSync(path, stringifyYaml(next))
  }
  return { changed: true, added: overlay, alreadyDisabled: already.length, file: path }
}

/**
 * Remove the entries `enterSafeMode` added, leaving the user's own patches untouched.
 * @param {string} profileDir
 * @param {{dryRun?: boolean}} [options]
 */
export function restoreSafeMode(profileDir, { dryRun = false } = {}) {
  const path = join(profileDir, 'cordis.patch.yml')
  const entries = readProfilePatch(profileDir)
  const kept = entries.filter((entry) => {
    const comment = typeof entry?.comment === 'string' ? entry.comment : ''
    return !comment.startsWith(SAFE_MARKER)
  })
  const removed = entries.length - kept.length
  if (removed > 0 && !dryRun) writeFileSync(path, stringifyYaml(kept))
  return { removed, file: path }
}

/**
 * Switch one plugin off by appending a `disabled: true` overlay.
 *
 * This is the alternative offered when a plugin cannot be rescued: make DSH usable again rather
 * than leaving a plugin that will not load. Nothing on disk is modified except the profile's own
 * patch layer, which the host already treats as user config, so re-enabling is exact.
 * @param {string} profileDir
 * @param {{name: string, id?: string, now?: Date}} target
 */
export function disablePlugin(profileDir, { name, id, now = new Date() }) {
  const path = join(profileDir, 'cordis.patch.yml')
  const entries = readProfilePatch(profileDir)
  const matches = entries.filter(entry => entryTargets(entry, name, id))
  if (matches.length > 0 && matches.some(entry => entry.disabled === true)) {
    return { changed: false, added: [], reason: 'already-disabled', file: path }
  }
  // Prefer the id the profile already uses; falling back to the name keeps the overlay valid
  // for a bundle that is listed in `bundles` but has no explicit patch entry.
  const anchor = matches[0] ?? {}
  const overlay = {
    ...(typeof anchor.id === 'string' ? { id: anchor.id } : {}),
    name,
    disabled: true,
    comment: `${DISABLE_MARKER}: disabled ${now.toISOString()} because it cannot load on this DSH version. `
      + 'Remove with dsh-plugin-health rescue, or re-enable it from the plugin health panel.',
  }
  writeFileSync(path, stringifyYaml([...entries, overlay]))
  return { changed: true, added: [overlay], file: path }
}

/**
 * Remove the disable overlays for one plugin, leaving every other entry untouched.
 * @param {string} profileDir
 * @param {{name: string, id?: string}} target
 */
export function enablePlugin(profileDir, { name, id }) {
  const path = join(profileDir, 'cordis.patch.yml')
  const entries = readProfilePatch(profileDir)
  const kept = entries.filter(entry => !(entryTargets(entry, name, id) && entry.disabled === true
    && typeof entry.comment === 'string' && entry.comment.startsWith(DISABLE_MARKER)))
  const removed = entries.length - kept.length
  if (removed > 0) writeFileSync(path, stringifyYaml(kept))
  return { changed: removed > 0, removed, file: path }
}

/** Marker distinguishing a per-plugin disable from the whole-profile safe-mode overlay. */
export const DISABLE_MARKER = 'dsh-plugin-health-disabled'

/** Whether a patch entry refers to the plugin identified by name and/or id. */
function entryTargets(entry, name, id) {
  if (typeof entry?.name === 'string' && entry.name === name) return true
  if (typeof id === 'string' && entry?.id === id) return true
  return false
}

/**
 * Write the diagnosis next to the profile so a user can attach it to a bug report
 * without scrolling a terminal.
 * @param {string} profileDir
 * @param {object} diagnosis
 * @returns {string} path written
 */
export function writeDiagnosisReport(profileDir, diagnosis) {
  const directory = join(profileDir, 'plugin-health-boot')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `diagnosis-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
  writeFileSync(path, `${JSON.stringify(diagnosis, null, 2)}\n`)
  return path
}
