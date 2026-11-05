/**
 * Rescue: turn a plugin the host gate rejects into one that is verified to run.
 *
 * The order here is deliberate and is the whole safety story:
 *
 *   1. rehearse in a throwaway DSH home  (nothing of the user is touched)
 *   2. only if the rehearsal boots, grant the official exact-version exemption
 *      in the *real* profile
 *   3. re-verify in the real profile state and record what was done
 *
 * Doing it the other way round — grant first, test afterwards — would leave a
 * user's profile carrying an exemption for a plugin that still cannot load,
 * which is worse than the original rejection because the gate would no longer
 * warn about it.
 *
 * Every mutation is recorded in a state file next to the profile so that
 * `undo` can restore the previous state exactly, and so that later runs can
 * tell the user when an upstream release makes the exemption unnecessary.
 * @module rescue/rescue
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { evaluatePluginCompatibility } from '../compat/evaluate.js'
import { runRuntimeSmoke, resolvePluginIdentity } from '../runtime/smoke.js'

/** Filename the host itself uses for exact-version exemptions, per profile. */
export const EXEMPTION_FILE = 'compatibility.json'

/** Where this tool remembers what it changed, per profile. */
export const RESCUE_STATE_FILE = 'plugin-health-rescue.json'

/**
 * Read the host's exemption map for a profile, tolerating damage.
 *
 * Tolerant is right for a *scan*: a health check that crashes on a malformed file is worse than one
 * that reports it. It is wrong before a *write* — `writeExemptions` uses `readExemptionsForWrite`,
 * because writing back a shrunk view is how the whole file gets replaced by a single entry after a
 * truncated or extended `compatibility.json`.
 * @param {string} profileDir
 * @returns {Record<string, string[]>}
 */
export function readExemptions(profileDir) {
  const { exemptions } = readExemptionsForWrite(profileDir, { tolerate: true })
  return exemptions
}

/**
 * Read the exemption map in a form that is safe to write back.
 *
 * A missing file is a legitimate empty map; anything else that cannot be understood is an error, so
 * the caller refuses to write rather than silently discarding a user's (or the host's) data. Keys the
 * tool does not understand are preserved verbatim.
 * @param {string} profileDir
 * @param {{tolerate?: boolean}} [options] - tolerate turns every failure into an empty map.
 * @returns {{exemptions: Record<string, string[]>, raw: Record<string, unknown>}}
 */
export function readExemptionsForWrite(profileDir, { tolerate = false } = {}) {
  const path = join(profileDir, EXEMPTION_FILE)
  if (!existsSync(path)) return { exemptions: {}, raw: {} }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (tolerate) return { exemptions: {}, raw: {} }
    throw new Error(`refusing to rewrite ${EXEMPTION_FILE}: it is not valid JSON (${error.message})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    if (tolerate) return { exemptions: {}, raw: {} }
    throw new Error(`refusing to rewrite ${EXEMPTION_FILE}: expected a JSON object`)
  }
  const exemptions = {}
  for (const [key, versions] of Object.entries(parsed)) {
    if (Array.isArray(versions)) exemptions[key] = versions.filter(v => typeof v === 'string')
  }
  return { exemptions, raw: parsed }
}

/**
 * Write the exemption map atomically, keeping the previous file and unknown keys.
 * @param {string} profileDir
 * @param {Record<string, string[]>} exemptions
 * @param {Record<string, unknown>} [raw] - the file as read, so unknown keys survive.
 */
function writeExemptions(profileDir, exemptions, raw = {}) {
  const path = join(profileDir, EXEMPTION_FILE)
  mkdirSync(dirname(path), { recursive: true })
  // Start from the keys we do not own. An exemption is a `string[]`; anything else belongs to the
  // host or to a newer version of it and survives untouched. Exemption keys then come solely from
  // the caller, so a key it dropped really is gone and one it added is written.
  const next = {}
  for (const [key, value] of Object.entries(raw)) {
    const isExemption = Array.isArray(value) && value.every(entry => typeof entry === 'string')
    if (!isExemption) next[key] = value
  }
  for (const [key, versions] of Object.entries(exemptions)) {
    if (Array.isArray(versions) && versions.length === 0) continue
    next[key] = versions
  }
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' })
    if (existsSync(path)) copyFileSync(path, `${path}.bak-plugin-health`)
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

/**
 * Read the rescue ledger for a profile.
 * @param {string} profileDir
 * @returns {{version: number, entries: object[]}}
 */
export function readRescueState(profileDir) {
  const path = join(profileDir, RESCUE_STATE_FILE)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed?.entries)) return { version: 1, entries: parsed.entries }
  } catch {
    // No ledger yet, or it was truncated by a hard kill. Starting empty is safe:
    // the exemption file remains the source of truth for what the host will do.
  }
  return { version: 1, entries: [] }
}

/**
 * Write the rescue ledger, keeping a copy of the previous one.
 * @param {string} profileDir
 * @param {{version: number, entries: object[]}} state
 */
export function writeRescueState(profileDir, state) {
  const path = join(profileDir, RESCUE_STATE_FILE)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) writeFileSync(`${path}.bak`, readFileSync(path))
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Decide whether a plugin is worth rehearsing: the gate must reject it, and the
 * rejection must be a declaration mismatch rather than a missing/broken package.
 * @param {object} manifest - installed plugin package.json
 * @param {string} runtimeVersion
 * @returns {{blocked: boolean, requirements: Record<string,string>}}
 */
export function declarationConflict(manifest, runtimeVersion) {
  try {
    const issue = evaluatePluginCompatibility(manifest, { runtimeVersion })
    return { blocked: issue !== undefined, requirements: issue?.requirements ?? {} }
  } catch (error) {
    return { blocked: false, requirements: {}, error: error.message }
  }
}

/**
 * Rehearse a rescue using a separate temporary DSH data directory. Health does not write a
 * normal-profile exemption here; executed plugin code retains the current account's permissions.
 * @returns {Promise<{verdict: 'runs'|'broken'|'inconclusive', report: object}>}
 */
export async function rehearse({ dshDirectory, plugin, pluginName, pluginVersion, runtimeVersion, timeoutMs, installTimeoutMs, out }) {
  const report = await runRuntimeSmoke({
    dshDirectory, plugin, bootOnly: true, bypassGate: true,
    // The identity travels separately from the spec. `runRuntimeSmoke` treats a spec that happens to
    // exist on disk as a path, so an attacker-chosen name must never be the only source of identity.
    pluginName, pluginVersion, registryOnly: pluginName !== undefined,
    timeoutMs, installTimeoutMs, out,
  })
  const install = report.stages.find(stage => stage.name === 'install')
  const runtime = report.stages.find(stage => stage.name === 'runtime')
  // A rejected install after the exemption already failed means our bypass could not
  // be applied; that says nothing about the plugin, so it must not be reported as broken.
  if (!report.ok && report.stages.some(stage => stage.name === 'allow-version' && !stage.ok)) {
    return { verdict: 'inconclusive', report }
  }
  if (!install?.ok) return { verdict: 'inconclusive', report }
  // All three have to hold. `details.ok` only reports what the worker saw inside its own checks; the
  // parent separately computes `report.ok` and `runtime.ok`, which go false on a timeout, on a plugin
  // that leaves a process behind, and on a non-zero exit. Reading `details` alone let a plugin that
  // never shut down count as a pass — and the exemption then covered a host the plugin had just been
  // shown to hang on.
  if (report.ok === true && runtime?.ok === true && runtime?.details?.ok === true) {
    return { verdict: 'runs', report }
  }
  return { verdict: 'broken', report }
}

/**
 * Grant the exemption in a real profile. Idempotent: repeats only add the version.
 * Returns the exemption value that was present before, so `undo` can restore it.
 * @param {string} profileDir
 * @param {{name: string, version: string, runtimeVersion: string}} target
 */
export function grantExemption(profileDir, { name, version, runtimeVersion }) {
  const key = `${name}@${version}`
  // Writing a null here would produce an exemption that can never match and a ledger entry that
  // cannot be explained later, so the value is validated at the last possible moment too.
  if (typeof runtimeVersion !== 'string' || runtimeVersion === '') {
    throw new Error(`refusing to exempt ${key} without a host version`)
  }
  // Strict read: `compatibility.json` may have been truncated by a crashed write, or extended by a
  // newer host. Reading it tolerantly and writing the shrunk result back would replace the user's
  // whole file with the one entry this call adds.
  const { exemptions, raw } = readExemptionsForWrite(profileDir)
  const previous = exemptions[key] ?? null
  const next = [...new Set([...(previous ?? []), runtimeVersion])]
  writeExemptions(profileDir, { ...exemptions, [key]: next }, raw)
  return { key, previous, granted: next }
}

/**
 * Remove one runtime version from an exemption, restoring the previous value when
 * this tool was the one that created the key.
 * @param {string} profileDir
 * @param {{key: string, previous: string[]|null, runtimeVersion: string}} entry
 */
export function revokeExemption(profileDir, { key, previous, runtimeVersion }) {
  const { exemptions, raw } = readExemptionsForWrite(profileDir)
  if (!Object.hasOwn(exemptions, key)) return { changed: false, key }
  // Remove only the version this entry granted. Restoring a snapshot wholesale is what made a
  // second rescue on a newer host resurrect the version the first rescue had just revoked, leaving
  // an exemption nobody could undo once the ledger was cleared.
  const remaining = exemptions[key].filter(v => v !== runtimeVersion)
  if (remaining.length === 0) {
    delete exemptions[key]
  } else {
    exemptions[key] = remaining
  }
  void previous
  writeExemptions(profileDir, exemptions, raw)
  return { changed: true, key }
}

/**
 * Full rescue: rehearse, then apply only if the rehearsal proves the plugin runs.
 * @param {object} options
 * @param {string} options.profileDir
 * @param {string} options.dshDirectory
 * @param {string} options.plugin - exact `name@version` or local path
 * @param {string} options.runtimeVersion - the host version the user actually runs
 * @param {string} options.profile
 * @param {boolean} [options.dryRun]
 */
export async function rescuePlugin({
  profileDir, dshDirectory, plugin, suppliedIdentity, runtimeVersion, profile, dryRun = false,
  timeoutMs, installTimeoutMs, out, rehearseImpl = rehearse,
}) {
  // An exemption written without a version becomes `[null]` and then never matches, leaving an
  // entry nobody can audit and a second rescue that looks like a duplicate of the first.
  if (typeof runtimeVersion !== 'string' || runtimeVersion === '') {
    throw new Error('a rescue needs the exact host version it is granted for')
  }
  // When the caller already knows the identity (the UI route read it out of the installed manifest),
  // use it as-is. Re-deriving it from a string lets a directory that happens to be named like a spec
  // on the process's cwd decide which package gets installed and which exemption gets written.
  const identity = suppliedIdentity ?? resolvePluginIdentity(plugin)
  const { verdict, report } = await rehearseImpl({
    dshDirectory, plugin: `${identity.name}@${identity.version}`, runtimeVersion,
    pluginName: suppliedIdentity === undefined ? undefined : identity.name,
    pluginVersion: suppliedIdentity === undefined ? undefined : identity.version,
    timeoutMs, installTimeoutMs, out,
  })
  const base = { plugin: identity, runtimeVersion, profile, verdict, rehearsal: report }
  if (verdict !== 'runs') return { ...base, applied: false }
  // The rehearsal has to have booted the version we are about to exempt. Anything else — a cached
  // host from a previous release, a caller-supplied version that never got checked — means we would
  // be writing an exemption for a host this plugin was never proven on, which is the one thing the
  // whole flow exists to prevent.
  if (report?.hostVersion !== runtimeVersion) {
    return {
      ...base,
      verdict: 'inconclusive',
      applied: false,
      reason: `rehearsed on ${report?.hostVersion ?? 'an unknown host'}, refusing to exempt ${runtimeVersion}`,
    }
  }
  if (dryRun) return { ...base, applied: false, wouldApply: true }

  const grant = grantExemption(profileDir, { ...identity, runtimeVersion })
  const state = readRescueState(profileDir)
  const existing = state.entries.findIndex(entry => entry.key === grant.key && entry.runtimeVersion === runtimeVersion)
  const entry = {
    key: grant.key, name: identity.name, version: identity.version, runtimeVersion,
    profile, appliedAt: new Date().toISOString(),
    previous: grant.previous, granted: grant.granted,
    rehearsal: { verdict, runDirectory: report.directory ?? null },
  }
  if (existing === -1) state.entries.push(entry)
  else state.entries[existing] = entry
  writeRescueState(profileDir, state)
  return { ...base, applied: true, entry }
}

/**
 * Undo one rescue, or every rescue for a profile when no key is given.
 * @param {string} profileDir
 * @param {{key?: string, runtimeVersion?: string}} [filter]
 */
export function undoRescue(profileDir, filter = {}) {
  const state = readRescueState(profileDir)
  const keep = []
  const undone = []
  for (const entry of state.entries) {
    const matches = (filter.key === undefined || entry.key === filter.key)
      && (filter.runtimeVersion === undefined || entry.runtimeVersion === filter.runtimeVersion)
    if (!matches) { keep.push(entry); continue }
    undone.push({ ...entry, ...revokeExemption(profileDir, entry) })
  }
  writeRescueState(profileDir, { version: 1, entries: keep })
  return { undone, remaining: keep }
}

/**
 * Describe which rescues are still needed given the running host version, and
 * whether the installed plugin version has changed since the rescue (which is the
 * signal that an upstream fix finally landed).
 * @param {string} profileDir
 * @param {{readManifest: (name: string) => object|undefined, runtimeVersion: string}} options
 */
export function auditRescues(profileDir, { readManifest, runtimeVersion }) {
  const exemptions = readExemptions(profileDir)
  const state = readRescueState(profileDir)
  return state.entries.map((entry) => {
    const live = exemptions[entry.key] ?? []
    const active = live.includes(entry.runtimeVersion)
    let stale = false
    let installedVersion
    try {
      installedVersion = readManifest(entry.name)?.version
    } catch {
      installedVersion = undefined
    }
    if (active && installedVersion !== undefined && installedVersion !== entry.version) stale = true
    return { ...entry, active, installedVersion, stale, exemptedVersions: live, runtimeVersion }
  })
}
