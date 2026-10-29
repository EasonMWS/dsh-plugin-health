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
 * List third-party entries: everything the host does not ship itself. Host packages are
 * the reference and must never be disabled — doing so would remove the very services a
 * plugin needs, which is the opposite of a fix.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function thirdPartyEntries(entries) {
  return entries.filter((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    const id = typeof entry?.id === 'string' ? entry.id : ''
    return name !== '' && !name.startsWith('@deepseek-ai/') && !id.startsWith('dsh-plugin-health')
  })
}

/**
 * Inspect the artifacts a failed boot leaves behind. Returns plain observations, not
 * conclusions: the caller decides how to present them.
 * @param {string} profileDir
 * @param {{maxLogs?: number}} [options]
 */
export function readBootEvidence(profileDir, { maxLogs = LOG_TAIL } = {}) {
  const logsDir = join(profileDir, '.plugin-manager', 'logs')
  const evidence = { operations: [], newestOperation: null, bootLog: null }
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
 * @returns {{suspects: object[], failures: object[], evidence: object, advice: string[]}}
 */
export function diagnoseBoot({ profileDir }) {
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
  const evidence = readBootEvidence(profileDir)
  const failures = []
  for (const operation of evidence.operations) failures.push(...detectBootFailures(operation.tail))
  if (evidence.bootLog !== null) failures.push(...detectBootFailures(evidence.bootLog.tail))
  if (failures.length === 0 && thirdParty.length > 0) {
    advice.push('No recognisable failure signature was found in the logs. '
      + 'If DSH does not start, run "safe" to disable third-party entries, then re-enable them one at a time.')
  }
  return {
    thirdParty,
    suspects: thirdParty.filter(entry => typeof entry?.name === 'string'),
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
