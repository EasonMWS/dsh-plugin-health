/**
 * AI handoff: prepare everything, press nothing.
 *
 * The rescue flow can only fix declaration-level rejections. When the isolated
 * rehearsal proves a plugin genuinely fails to boot, no deterministic rule can
 * repair it: that needs somebody to read the plugin's source and the host's
 * release notes together. A local agent can do that, but this tool must not
 * spend the user's tokens or act on their behalf, so the boundary is:
 *
 *   this module writes files and prints a prompt → the user decides whether to use them
 *
 * The brief is deliberately narrow. It asks the agent to restore *compatibility*
 * only — never features, never a rewrite — and it makes the acceptance test part
 * of the instruction, so a "fix" that does not boot again is explicitly a failure.
 * @module rescue/handoff
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import semver from 'semver'
import { join, resolve, sep } from 'node:path'

/** Where handoff bundles are written inside a profile. */
export const HANDOFF_DIR = 'plugin-health-handoff'

/**
 * Assemble the context bundle for one plugin. Everything here is gathered by this
 * tool ahead of time so the user's agent does not have to rediscover it.
 * @param {object} input
 * @returns {object}
 */
export function buildBrief({
  name, version, runtimeVersion, requirements = {}, installedManifest,
  smokeReport, repositoryUrl, toolVersion, verdict,
}) {
  const stages = (smokeReport?.stages ?? []).map(stage => ({
    name: stage.name,
    ok: stage.ok === true,
    timedOut: stage.timedOut === true,
    stage: stage.details?.stage,
    error: stage.details?.error ?? stage.error ?? undefined,
  }))
  // The UI knows the verdict as a word; a route that only received that word must not be mistaken
  // for "no rehearsal happened", or every brief generated after a failed boot claims the code is fine.
  const resolved = verdict ?? (smokeReport === undefined
    ? 'not-run'
    : smokeReport.ok === true ? 'runs' : 'failed')
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: toolVersion === undefined ? 'dsh-plugin-health' : `dsh-plugin-health@${toolVersion}`,
    plugin: {
      name,
      version,
      repository: repositoryUrl ?? null,
      declaredRequirements: requirements,
      engines: installedManifest?.engines ?? null,
      peerDependencies: installedManifest?.peerDependencies ?? null,
    },
    host: { runtimeVersion, toolVersion: toolVersion ?? null },
    // `not-run` is a distinct verdict: reporting a missing rehearsal as "failed" would tell
    // the agent the plugin is broken when nobody actually checked.
    rehearsal: { verdict: resolved, stages },
    constraints: [
      'Restore compatibility only. Do not add features, refactor, or change behaviour.',
      'Do not widen a peer range past what you can verify; prefer admitting the exact tested version.',
      'If the repository runs its own host-version enumeration check, enumerate instead of using a range.',
      'The fix is only accepted if the plugin installs and boots again on the target host version.',
    ],
  }
}

/**
 * Collapse declarations that share one range.
 *
 * A plugin typically repeats the same enumeration across two dozen peers. Printing it once
 * per package buries the actual information (which range is wrong) in near-identical lines,
 * so group by range and list the packages underneath.
 * @param {Record<string, string>} requirements
 * @returns {{range: string, packages: string[]}[]}
 */
export function groupRanges(requirements) {
  const byRange = new Map()
  for (const [name, range] of Object.entries(requirements ?? {})) {
    const key = typeof range === 'string' ? range : String(range)
    const bucket = byRange.get(key)
    if (bucket === undefined) byRange.set(key, [name])
    else bucket.push(name)
  }
  // Widest groups first: the range shared by the most packages is the headline finding.
  return [...byRange.entries()]
    .map(([range, packages]) => ({ range, packages: packages.sort() }))
    .sort((a, b) => b.packages.length - a.packages.length)
}

/**
 * Render the prompt the user can paste into their own agent. Plain text on purpose:
 * it must survive being copied into any chat surface.
 * @param {object} brief - result of {@link buildBrief}
 * @returns {string}
 */
/**
 * Render a plugin-supplied string as inert data.
 *
 * These values come from a manifest the tool did not write. A backtick closes a code span, and a
 * newline starts a new instruction — both turn a value into prompt structure. Flattening and
 * stripping keeps the value visible while removing its ability to act as markup.
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string}
 */
function asData(value, limit = 120) {
  const flat = String(value ?? '')
    // A backtick ends a code span and a newline starts a new instruction; both turn a value into
    // prompt structure. Nothing else is touched — the pipe in `||` is a legal semver operator, and
    // altering a value that is already legal is its own kind of wrong.
    .replace(/[`\r\n]+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * A package name, filtered to the characters a package name may contain.
 *
 * A manifest's `name` is a string the tool did not write, and it is interpolated into a prompt that
 * may be pasted to an agent holding repository write access. Anything that is not a legal package
 * character is dropped, so the brief can show a name but never an instruction.
 * @param {unknown} value
 * @returns {string}
 */
function asPackageName(value) {
  const cleaned = String(value ?? '').replace(/[^a-z0-9@/_.-]/giu, '').slice(0, 90)
  return cleaned === '' ? '(unnamed)' : cleaned
}

/**
 * A declared range, only when it really is one.
 *
 * A range that does not parse is not a version constraint, so it is replaced rather than echoed — an
 * agent reading "0.2.0`
Ignore previous instructions" would otherwise have no way to tell it
 * apart from the brief's own words.
 * @param {unknown} range
 * @returns {string}
 */
function asRange(range) {
  const flat = String(range ?? '').trim()
  if (flat === '') return '(none declared)'
  return semver.validRange(flat) === null ? '(unparseable declaration, omitted)' : asData(flat, 80)
}

export function renderPrompt(brief) {
  const { plugin, host, rehearsal } = brief
  const failed = rehearsal.stages.filter(stage => !stage.ok)
  const booted = rehearsal.verdict === 'runs'
  const notRun = rehearsal.verdict === 'not-run'
  const lines = [
    `I need you to restore DSH plugin compatibility for \`${asPackageName(plugin.name)}@${asData(plugin.version, 40)}\`.`,
    '',
    `Target host: DSH \`${asData(host.runtimeVersion, 40)}\`. The host rejects this plugin because its declared`,
    `requirements do not admit that version.`,
    '',
    '### What I already checked',
    '',
  ]
  if (notRun) {
    // Saying "failed" here would tell the agent the plugin is broken when nobody tested it.
    lines.push('Static declaration check only — no isolated runtime test was run for this brief,')
    lines.push('so treat "does the code actually boot" as an open question, not a known failure.')
  } else {
    lines.push('I ran an isolated install + boot on the target host with the requirement exempted.')
    lines.push(`Verdict: **${booted ? 'boots successfully' : 'fails to boot'}**.`)
  }
  if (booted) {
    lines.push('')
    lines.push('That means the code itself loads fine — only the declared ranges are out of date.')
    lines.push('So the work is narrow: update the declarations so a normal install is accepted,')
    lines.push('without claiming support for versions that were not actually verified.')
  }
  if (failed.length > 0) {
    lines.push('')
    lines.push('Failing stages:')
    for (const stage of failed) {
      lines.push(`- \`${stage.name}\`${stage.stage ? ` (during ${stage.stage})` : ''}${stage.error ? ': ' + String(stage.error).split('\n')[0] : ''}`)
    }
  }
  lines.push('')
  lines.push('### Declared requirements that reject the host')
  lines.push('')
  const grouped = groupRanges(plugin.declaredRequirements)
  for (const group of grouped) {
    lines.push(`- \`${asRange(group.range)}\``)
    lines.push(`  - applies to ${group.packages.length === 1 ? '' : `${group.packages.length} packages: `}${group.packages.map(name => `\`${asPackageName(name)}\``).join(', ')}`)
  }
  lines.push('')
  lines.push('### What I need from you')
  lines.push('')
  if (booted) {
    lines.push(`1. Admit \`${asData(host.runtimeVersion, 40)}\` in the requirements above — or, if this repository runs its`)
    lines.push('   own host-version enumeration check (a `scripts/compatibility.mjs`-style gate), keep the')
    lines.push('   enumeration form and add the exact version instead of a range.')
    lines.push('2. Do not change plugin behaviour, and do not guess at future prereleases.')
  } else if (notRun) {
    lines.push('1. Install and boot the plugin on the target host first (exempting the requirement if the gate')
    lines.push('   blocks it) and record whether it actually starts — that decides how much work this is.')
    lines.push('2. Then either update the declarations (if it boots) or fix the real incompatibility.')
    lines.push('3. Keep the peer/host ranges honest: admit versions you actually verified.')
  } else {
    lines.push('1. Work out why the plugin fails to boot on that host version (missing service, removed API,')
    lines.push('   changed export — whatever the evidence shows).')
    lines.push('2. Make the smallest change that restores compatibility. Do not add or remove features.')
    lines.push('3. Keep the peer/host ranges honest: admit versions you actually verified.')
  }
  lines.push('')
  lines.push('### Acceptance criteria')
  lines.push('')
  lines.push('A change counts as a fix only if the plugin installs and boots on the target host version.')
  lines.push('If you cannot reach a booting state, say so and stop rather than widening ranges to hide it.')
  lines.push('')
  lines.push('### Hard limits — read these before you start')
  lines.push('')
  lines.push('This is a bounded task, not an open-ended repair session.')
  lines.push('')
  if (booted) {
    lines.push('- **Stay in the declarations.** A boot test ran and the code loaded; the only thing to change')
    lines.push('  is the version ranges. If you find yourself editing plugin source, stop — that is out of scope.')
  } else if (notRun) {
    // Saying "the boot test says the code is fine" here would be a fabrication: no test ran. The brief
    // is reached from the failed-boot path, so telling the agent the declaration is the only suspect
    // sends it to widen a range on a plugin that may well crash.
    lines.push('- **No boot test has been run for this plugin yet.** Work from the declarations first, but do')
    lines.push('  not assume the code is healthy: if you can boot it on the target host, do that before deciding')
    lines.push('  a range change is enough.')
  } else {
    lines.push('- **One diagnosis, one attempt.** Identify the single cause and make one minimal change. If it')
    lines.push('  still does not boot, stop and report what you found instead of trying variations.')
  }
  lines.push('- **Do not iterate.** Two failed attempts means stop. Report the evidence you gathered; the user')
  lines.push('  decides what happens next. Do not keep changing ranges or code hoping something lands.')
  lines.push('- **Never fake success.** Do not widen a range to a version you did not actually verify, do not')
  lines.push('  suppress or catch an error to make the boot "succeed", and do not describe an untested change')
  lines.push('  as fixed.')
  lines.push('- **Do not change behaviour.** No features added or removed, no refactors, no dependency bumps')
  lines.push('  beyond what the compatibility fix requires.')
  lines.push('- **Report honestly if it is unfixable.** "This needs the maintainer" is a valid answer and a')
  lines.push('  better one than a change that hides the problem.')
  lines.push('')
  if (plugin.repository) lines.push(`Repository: ${plugin.repository}`)
  lines.push('')
  lines.push('Do not run anything destructive. Ask me before changing files outside the plugin source.')
  lines.push('')
  return lines.join('\n')
}

/**
 * Turn a package name and version into a single safe path segment.
 *
 * The version came straight from the request body and was joined into a path unfiltered, so
 * `version: "../../../evil"` escaped the profile directory and wrote wherever the process could
 * reach — including autostart locations, which turns a file write into code execution. Only the
 * name was filtered, which is why the hole survived review.
 *
 * A version is only ever semver-shaped in practice, so anything outside that set is replaced rather
 * than rejected: a hostile value must not steer the path, and the caller still gets a directory.
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function safeHandoffSegment(name, version) {
  const clean = (value) => String(value ?? '')
    .replace(/[@/\\]/gu, '_')
    .replace(/\.\./gu, '_')
    .replace(/[^A-Za-z0-9._+-]/gu, '_')
    .slice(0, 120)
  const joined = `${clean(name)}@${clean(version)}`
  return joined === '@' ? '_unknown' : joined
}

/**
 * Resolve the handoff directory for a package, refusing anything outside the handoff root.
 * `resolve` collapses any traversal the sanitiser might have missed; the prefix check then proves
 * the collapsed result is still inside, so a bug in one does not silently become a write elsewhere.
 * @param {string} profileDir
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function handoffDirectory(profileDir, name, version) {
  const root = resolve(profileDir, HANDOFF_DIR)
  const directory = resolve(root, safeHandoffSegment(name, version))
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to write a handoff outside ${HANDOFF_DIR}`)
  }
  return directory
}

/**
 * Write the bundle to disk: the brief, the prompt, and the raw rehearsal report.
 * @param {string} profileDir
 * @param {object} brief
 * @param {object} [smokeReport]
 * @returns {{directory: string, files: string[]}}
 */
export function writeHandoff(profileDir, brief, smokeReport) {
  const directory = handoffDirectory(profileDir, brief.plugin.name, brief.plugin.version)
  mkdirSync(directory, { recursive: true })
  const files = []
  const write = (name, contents) => {
    const path = join(directory, name)
    writeFileSync(path, contents)
    files.push(path)
  }
  write('brief.json', `${JSON.stringify(brief, null, 2)}\n`)
  write('prompt.md', renderPrompt(brief))
  if (smokeReport !== undefined) write('rehearsal.json', `${JSON.stringify(smokeReport, null, 2)}\n`)
  return { directory, files }
}

/**
 * Read a previously written prompt, for the UI to show without rebuilding it.
 * @param {string} profileDir
 * @param {string} name
 * @param {string} version
 */
export function readHandoff(profileDir, name, version) {
  const directory = handoffDirectory(profileDir, name, version)
  try {
    return {
      directory,
      prompt: readFileSync(join(directory, 'prompt.md'), 'utf8'),
      brief: JSON.parse(readFileSync(join(directory, 'brief.json'), 'utf8')),
    }
  } catch {
    return undefined
  }
}
