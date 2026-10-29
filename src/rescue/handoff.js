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
import { join } from 'node:path'

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
  smokeReport, repositoryUrl, toolVersion,
}) {
  const stages = (smokeReport?.stages ?? []).map(stage => ({
    name: stage.name,
    ok: stage.ok === true,
    timedOut: stage.timedOut === true,
    stage: stage.details?.stage,
    error: stage.details?.error ?? stage.error ?? undefined,
  }))
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
    rehearsal: {
      verdict: smokeReport === undefined ? 'not-run' : smokeReport.ok === true ? 'runs' : 'failed',
      stages,
    },
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
export function renderPrompt(brief) {
  const { plugin, host, rehearsal } = brief
  const failed = rehearsal.stages.filter(stage => !stage.ok)
  const booted = rehearsal.verdict === 'runs'
  const notRun = rehearsal.verdict === 'not-run'
  const lines = [
    `I need you to restore DSH plugin compatibility for \`${plugin.name}@${plugin.version}\`.`,
    '',
    `Target host: DSH \`${host.runtimeVersion}\`. The host rejects this plugin because its declared`,
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
    lines.push(`- \`${group.range}\``)
    lines.push(`  - applies to ${group.packages.length === 1 ? '' : `${group.packages.length} packages: `}${group.packages.map(name => `\`${name}\``).join(', ')}`)
  }
  lines.push('')
  lines.push('### What I need from you')
  lines.push('')
  if (booted) {
    lines.push(`1. Admit \`${host.runtimeVersion}\` in the requirements above — or, if this repository runs its`)
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
  if (notRun || booted) {
    lines.push('- **Stay in the declarations.** The boot test says the code is fine; the only thing to change is')
    lines.push('  the version ranges. If you find yourself editing plugin source, stop — that is out of scope.')
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
 * Write the bundle to disk: the brief, the prompt, and the raw rehearsal report.
 * @param {string} profileDir
 * @param {object} brief
 * @param {object} [smokeReport]
 * @returns {{directory: string, files: string[]}}
 */
export function writeHandoff(profileDir, brief, smokeReport) {
  const directory = join(profileDir, HANDOFF_DIR, `${brief.plugin.name.replace(/[@/]/gu, '_')}@${brief.plugin.version}`)
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
  const directory = join(profileDir, HANDOFF_DIR, `${name.replace(/[@/]/gu, '_')}@${version}`)
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
