/**
 * Why a smoke run failed, as one word a page can translate and a reader can filter on.
 *
 * Only the stage that failed is read. Earlier stages can contain alarming words that are not the cause: pnpm
 * prints "WARN GET … error (ECONNRESET). Will retry" during an install that then succeeds, and reading it would
 * turn a later boot failure into "network".
 *
 * Rules are tried in order and the first match wins, so a more specific cause has to come before a more
 * general one: "waiting for connection" is also "did not activate", and the waiting is the useful part.
 */

/** @typedef {{ stage: string, kind: string, detail: string }} Failure */

const INSTALL = new Set(['install', 'allow-version'])
const RUNTIME = new Set(['runtime'])

/**
 * Each rule: which stages it may describe, and what to look for in that stage's text or flags.
 * `kind` values are a stable vocabulary: pages and other tools key on them, so they are append-only.
 */
const RULES = [
  { kind: 'gate-rejected', stages: INSTALL, text: /incompatible with dsh|incompatible-version|installation rejected/iu },
  { kind: 'not-found', stages: INSTALL, text: /ERR_PNPM_NO_MATCHING_VERSION|No matching version found|\b404\b|\bnot found\b|ERR_PNPM_FETCH_404/iu },
  { kind: 'build-scripts-blocked', stages: INSTALL, text: /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts|approve-builds|allowBuilds|build scripts? (?:were|was) ignored/iu },
  { kind: 'peer-conflict', stages: INSTALL, text: /ERR_PNPM_PEER_DEP_ISSUES|unmet peer|conflicting peer/iu },
  { kind: 'network', stages: null, text: /\b(?:ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b|ERR_PNPM_FETCH_|ERR_PNPM_META_FETCH_FAIL/u },
  { kind: 'install-timeout', stages: INSTALL, flag: (stage) => stage.timedOut === true },
  { kind: 'host-contract-changed', stages: RUNTIME, text: /host-contract-changed:/u },
  { kind: 'boot-import-error', stages: RUNTIME, text: /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|SyntaxError: /u },
  { kind: 'missing-service', stages: RUNTIME, text: /waiting for/iu },
  { kind: 'not-mounted', stages: RUNTIME, text: /never entered the profile/iu },
  { kind: 'not-activated', stages: RUNTIME, text: /did not activate/iu },
  { kind: 'tool-missing', stages: RUNTIME, text: /tool did not register/iu },
  { kind: 'call-failed', stages: RUNTIME, text: /tool returned an error|unexpected value from|no result for /iu },
  { kind: 'shutdown-hang', stages: RUNTIME, text: /shutdown failed/iu, flag: (stage) => stage.timedOut === true },
  { kind: 'orphan-process', stages: null, flag: (stage) => stage.orphaned === true },
]

/** Every kind this module can return, in rule order, plus the fallback. */
export const FAILURE_KINDS = Object.freeze([...RULES.map((rule) => rule.kind), 'unknown'])

/** All text a stage carries, in the order a human would read it. */
function stageText(stage) {
  return [stage.details?.error, stage.error, stage.stderr, stage.stdout]
    .filter((part) => typeof part === 'string' && part !== '')
    .join('\n')
}

/** The line that matched, trimmed, so the detail is something a reader recognises from the log. */
function matchingLine(text, pattern) {
  const line = text.split(/\r?\n/u).find((row) => pattern.test(row)) ?? ''
  return line.trim().slice(0, 300)
}

/** First line worth showing when nothing matched. */
function firstLine(text) {
  return (text.split(/\r?\n/u).find((row) => row.trim() !== '' && !/^\s*at /u.test(row)) ?? '').trim().slice(0, 300)
}

/**
 * @param {object} report - a smoke report (`smoke.json`).
 * @returns {Failure|null} null when the run passed.
 */
export function classifyFailure(report) {
  if (!report || report.ok === true) return null
  const stages = Array.isArray(report.stages) ? report.stages : []
  const failed = stages.find((stage) => stage.ok === false)
  if (!failed) {
    // The orchestrator itself threw before or between stages.
    const text = typeof report.error === 'string' ? report.error : ''
    const network = RULES.find((rule) => rule.kind === 'network')
    if (network.text.test(text)) return { stage: 'setup', kind: 'network', detail: matchingLine(text, network.text) }
    return { stage: 'setup', kind: 'unknown', detail: firstLine(text) }
  }
  const text = stageText(failed)
  for (const rule of RULES) {
    if (rule.stages && !rule.stages.has(failed.name)) continue
    if (rule.flag?.(failed)) {
      return { stage: failed.name, kind: rule.kind, detail: (rule.text && matchingLine(text, rule.text)) || firstLine(text) || `${failed.name} ${rule.kind}` }
    }
    if (rule.text?.test(text)) return { stage: failed.name, kind: rule.kind, detail: matchingLine(text, rule.text) }
  }
  return { stage: failed.name, kind: 'unknown', detail: firstLine(text) }
}
