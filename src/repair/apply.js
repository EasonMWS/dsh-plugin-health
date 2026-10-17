/**
 * Safe repairs for findings produced by `inspectDshHome`.
 * Repairs never delete: files and directories move to a quarantine directory first, and the
 * patch rewrite is a minimal text edit (comments and formatting survive) after a backup.
 * @module repair/apply
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'

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
  const stamp = now.toISOString().replace(/[:.]/gu, '-')
  const root = quarantineDir !== undefined && quarantineDir !== ''
    ? quarantineDir
    : join(home, '.plugin-health', 'quarantine', stamp)
  const actions = []
  const skipped = manual
  if (!dryRun && auto.length > 0) mkdirSync(root, { recursive: true })

  for (const finding of auto) {
    const fix = finding.fix
    if (fix.kind === 'quarantine') {
      const target = fix.target ?? finding.path
      if (typeof target !== 'string' || !existsSync(target)) {
        skipped.push({ ...finding, skipReason: 'target no longer exists' })
        continue
      }
      const destination = uniqueDestination(root, relative(home, target), target)
      const action = { kind: 'quarantine', finding: finding.id, from: target, to: destination }
      if (!dryRun) {
        mkdirSync(dirname(destination), { recursive: true })
        try {
          renameSync(target, destination)
        } catch {
          cpSync(target, destination, { recursive: true, force: true })
          rmSync(target, { recursive: true, force: true })
        }
      }
      actions.push(action)
      continue
    }
    if (fix.kind === 'rewrite-patch') {
      const target = fix.path
      if (typeof target !== 'string' || !existsSync(target)) {
        skipped.push({ ...finding, skipReason: 'patch file no longer exists' })
        continue
      }
      const original = readFileSync(target, 'utf8')
      const edited = removeEmptyPatchEntries(original)
      if (edited === original) {
        skipped.push({ ...finding, skipReason: 'patch file already clean' })
        continue
      }
      const backup = uniqueDestination(root, relative(home, target), target)
      const action = { kind: 'rewrite-patch', finding: finding.id, file: target, backup }
      if (!dryRun) {
        mkdirSync(dirname(backup), { recursive: true })
        copyFileSync(target, backup)
        const temporary = `${target}.health-${stamp}.tmp`
        writeFileSync(temporary, edited)
        renameSync(temporary, target)
      }
      actions.push(action)
      continue
    }
    skipped.push({ ...finding, skipReason: `unsupported automatic fix: ${fix.kind}` })
  }

  if (!dryRun) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'repair-log.json'), `${JSON.stringify({ at: now.toISOString(), home, dryRun, actions, skipped: skipped.map(({ id, title }) => ({ id, title })) }, null, 2)}\n`)
  }
  return { dryRun, quarantineDir: root, actions, skipped }
}

function uniqueDestination(root, relativePath, target) {
  const base = join(root, relativePath.replace(/^[A-Za-z]:/u, '').replace(/^[/\\]+/u, ''))
  let candidate = base
  let counter = 1
  while (existsSync(candidate)) {
    candidate = `${base}.${counter}`
    counter += 1
  }
  return candidate
}
