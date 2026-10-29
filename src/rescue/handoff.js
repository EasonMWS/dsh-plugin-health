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
    rehearsal: { verdict: smokeReport?.ok === true ? 'runs' : 'failed', stages },
    constraints: [
      'Restore compatibility only. Do not add features, refactor, or change behaviour.',
      'Do not widen a peer range past what you can verify; prefer admitting the exact tested version.',
      'If the repository runs its own host-version enumeration check, enumerate instead of using a range.',
      'The fix is only accepted if the plugin installs and boots again on the target host version.',
    ],
  }
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
  const lines = [
    `I need you to restore DSH plugin compatibility for \`${plugin.name}@${plugin.version}\`.`,
    '',
    `Target host: DSH \`${host.runtimeVersion}\`. The host rejects this plugin because its declared`,
    `requirements do not admit that version.`,
    '',
    '### What I already checked',
    '',
    'I ran an isolated install + boot on the target host with the requirement exempted.',
    `Verdict: **${rehearsal.verdict}**.`,
  ]
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
  for (const [requirement, range] of Object.entries(plugin.declaredRequirements)) {
    lines.push(`- \`${requirement}\`: \`${range}\``)
  }
  lines.push('')
  lines.push('### What I need from you')
  lines.push('')
  if (booted) {
    lines.push(`1. Add \`${host.runtimeVersion}\` to the requirements above — or, if this repository runs its`)
    lines.push('   own host-version enumeration check (a `scripts/compatibility.mjs`-style gate), keep the')
    lines.push('   enumeration form and add the exact version instead of a range.')
    lines.push('2. Do not change plugin behaviour, and do not guess at future prereleases.')
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
