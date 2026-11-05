/**
 * Safe repairs for findings produced by `inspectDshHome`.
 * Repairs never delete: files and directories move to a quarantine directory first, and the
 * patch rewrite is a minimal text edit (comments and formatting survive) after a backup.
 * @module repair/apply
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const repairRoot = (home) => join(home, '.plugin-health', 'quarantine')

function inside(root, path) {
  const tail = relative(root, path)
  return tail !== '' && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}

function fileInfo(path) {
  try { return lstatSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function mkdirInside(root, directory) {
  if (root === directory) return
  if (!inside(root, directory)) throw new Error('quarantine path is outside the repair directory')
  let current = root
  for (const part of relative(root, directory).split(sep)) {
    current = join(current, part)
    if (!fileInfo(current)) {
      try { mkdirSync(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    if (!fileInfo(current)?.isDirectory()) throw new Error('quarantine path contains a link or non-directory')
  }
}

function assertProfileTarget(home, target, patch) {
  const profiles = join(home, 'profiles')
  const parts = relative(profiles, target).split(sep)
  if (!inside(profiles, target) || parts.length < 2 || (patch && (parts.length !== 2 || basename(target) !== 'cordis.patch.yml'))) {
    throw new Error('repair target must be inside a profile')
  }
  const parent = realpathSync(dirname(target))
  if (!inside(join(realpathSync(home), 'profiles'), parent)) throw new Error('repair target parent resolves outside the profiles')
  if (patch && !fileInfo(target)?.isFile()) throw new Error('repair requires a regular patch file')
}

function atomicWrite(path, bytes, beforeReplace = () => {}) {
  const temporary = `${path}.health-${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    beforeReplace()
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

/**
 * Split findings into automatic repairs and manual follow-ups.
 * @param {readonly object[]} findings - diagnostics from `inspectDshHome`.
 * @returns {{auto: object[], manual: object[]}} grouped findings.
 */
export function planRepairs(findings) {
  const auto = []
  const manual = []
  for (const finding of findings) {
    if (finding.fix?.auto === true) auto.push(finding)
    else manual.push(finding)
  }
  return { auto, manual }
}

/**
 * Remove top-level empty `[]` patch entries from cordis.patch.yml text without touching comments.
 * @param {string} text - original YAML.
 * @returns {string} edited YAML.
 */
export function removeEmptyPatchEntries(text) {
  const lines = text.split(/\r?\n/u)
  const kept = lines.filter((line) => !/^-\s*\[\s*\]\s*$/u.test(line))
  if (kept.length === lines.length) return text
  const edited = kept.join('\n')
  parseYaml(edited) // throws when the edit broke the document; callers restore the backup
  return edited
}

/**
 * Plan or apply safe repairs.
 * @param {readonly object[]} findings - diagnostics.
 * @param {{home: string, dryRun?: boolean, quarantineDir?: string, now?: Date}} options
 * @returns {Promise<{dryRun: boolean, quarantineDir: string, actions: object[], skipped: object[]}>}
 */
export async function applyRepairs(findings, { home, dryRun = true, quarantineDir, now = new Date() }) {
  const { auto, manual } = planRepairs(findings)
  home = resolve(home)
  const stamp = `${now.toISOString().replace(/[:.]/gu, '-')}-${randomBytes(6).toString('hex')}`
  const root = quarantineDir ? resolve(quarantineDir) : join(repairRoot(home), stamp)
  const actions = []
  const skipped = manual
  const journal = join(root, 'repair-log.json')
  let prepared = false
  const record = (action) => {
    actions.push(action)
    if (dryRun) return
    atomicWrite(journal, `${JSON.stringify({ schemaVersion: 2, at: now.toISOString(), home, dryRun, actions }, null, 2)}\n`)
  }
  const prepare = (destination) => {
    if (!prepared) {
      if (fileInfo(journal)) throw new Error('the quarantine directory already contains a repair journal')
      if (quarantineDir) mkdirSync(root, { recursive: true })
      else mkdirInside(home, root)
      prepared = true
    }
    mkdirInside(root, dirname(destination))
  }

  for (const finding of auto) {
    const fix = finding.fix
    if (fix.kind === 'quarantine') {
      const target = fix.target ?? finding.path
      if (typeof target !== 'string' || !fileInfo(target)) {
        skipped.push({ ...finding, skipReason: 'target no longer exists' })
        continue
      }
      assertProfileTarget(home, target, false)
      const destination = uniqueDestination(root, relative(home, target))
      const action = { kind: 'quarantine', finding: finding.id, from: resolve(target), to: destination }
      if (!dryRun) {
        prepare(destination)
        record(action)
        // A move is atomic on the same volume. A failed move leaves the source in place.
        renameSync(target, destination)
      } else {
        record(action)
      }
      continue
    }
    if (fix.kind === 'rewrite-patch') {
      const target = fix.path
      if (typeof target !== 'string' || !existsSync(target)) {
        skipped.push({ ...finding, skipReason: 'patch file no longer exists' })
        continue
      }
      assertProfileTarget(home, target, true)
      const original = readFileSync(target)
      const edited = removeEmptyPatchEntries(original.toString('utf8'))
      if (edited === original.toString('utf8')) {
        skipped.push({ ...finding, skipReason: 'patch file already clean' })
        continue
      }
      const backup = uniqueDestination(root, relative(home, target))
      const action = { kind: 'rewrite-patch', finding: finding.id, file: resolve(target), backup, before: hash(original), after: hash(edited) }
      if (!dryRun) {
        prepare(backup)
        writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
        record(action)
        atomicWrite(target, edited, () => {
          assertProfileTarget(home, target, true)
          if (hash(readFileSync(target)) !== action.before) throw new Error('patch changed during repair')
        })
      } else {
        record(action)
      }
      continue
    }
    skipped.push({ ...finding, skipReason: `unsupported automatic fix: ${fix.kind}` })
  }

  return { dryRun, quarantineDir: root, actions, skipped, restoreRun: !dryRun && !quarantineDir && actions.length ? stamp : null }
}

function uniqueDestination(root, relativePath) {
  const base = join(root, relativePath.replace(/^[A-Za-z]:/u, '').replace(/^[/\\]+/u, ''))
  let candidate = base
  let counter = 1
  while (fileInfo(candidate)) {
    candidate = `${base}.${counter}`
    counter += 1
  }
  return candidate
}

/** Preview or undo a repair in the default quarantine. Later edits are treated as conflicts. */
export function restoreRepairs({ home, run, dryRun = true }) {
  home = resolve(home)
  if (typeof run !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{12}$/u.test(run)) {
    throw new Error('restore needs the repair directory name printed when the repair completed')
  }
  const root = join(repairRoot(home), run)
  if (realpathSync(root) !== join(realpathSync(home), '.plugin-health', 'quarantine', run)) {
    throw new Error('quarantine directory resolves outside this DSH home')
  }
  const journal = join(root, 'repair-log.json')
  const info = fileInfo(journal)
  if (!info?.isFile() || info.size > 4 * 1024 * 1024) throw new Error('repair journal is missing or invalid')
  const ledger = JSON.parse(readFileSync(journal, 'utf8'))
  if (ledger.schemaVersion !== 2 || ledger.home !== home || !Array.isArray(ledger.actions)) throw new Error('unsupported repair journal')

  const results = []
  for (const action of [...ledger.actions].reverse()) {
    const patch = action.kind === 'rewrite-patch'
    const target = patch ? action.file : action.from
    const backup = patch ? action.backup : action.to
    let state
    try {
      if ((!patch && action.kind !== 'quarantine') || typeof target !== 'string' || typeof backup !== 'string' ||
          !inside(root, backup) || relative(root, backup) !== relative(home, target) ||
          !inside(realpathSync(root), realpathSync(dirname(backup)))) throw new Error('invalid journal action')
      assertProfileTarget(home, target, patch)
      if (patch) {
        if (!fileInfo(backup)?.isFile()) throw new Error('patch backup missing')
        const original = readFileSync(backup)
        if (hash(original) !== action.before) throw new Error('patch backup changed')
        const current = hash(readFileSync(target))
        if (current === action.before) state = 'already-original'
        else if (current !== action.after) throw new Error('patch changed since the repair')
        else if (!dryRun) {
          atomicWrite(target, original, () => {
            assertProfileTarget(home, target, true)
            if (hash(readFileSync(target)) !== action.after) throw new Error('patch changed during restore')
          })
          if (hash(readFileSync(target)) !== action.before) throw new Error('patch restore could not be verified')
        }
      } else if (fileInfo(target)) {
        if (fileInfo(backup)) throw new Error('original path is occupied')
        state = 'already-original'
      } else {
        if (!fileInfo(backup)) throw new Error('quarantined item missing')
        if (!dryRun) renameSync(backup, target)
      }
      results.push({ target, state: state ?? (dryRun ? 'would-restore' : 'restored') })
    } catch (error) {
      results.push({ target, state: 'blocked', reason: error.message })
    }
  }
  return { dryRun, results }
}
