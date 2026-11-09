import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { evaluatePluginCompatibility, pluginCompatibilityWarning } from '../src/compat/evaluate.js'

// `src/compat/evaluate.js` is a local copy of the host's compatibility judgement. If it drifts, the whole
// compatibility page is wrong and nothing says so.
//
// The corpus is not hand-written expectations — those would record what this tool believes the host does. It
// was captured by running the official `@deepseek-ai/dsh-app-boot` and storing its output, so the assertion
// below is "the mirror agrees with the thing it mirrors", checked offline.

const CORPUS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/compat-corpus.json', import.meta.url)), 'utf8'))

/**
 * Normalise a local result into the corpus shape.
 * @param {object|undefined} issue - local verdict, or undefined when compatible.
 */
function normalise(issue) {
  if (issue === undefined) return { compatible: true }
  return {
    compatible: false,
    requirements: issue.requirements,
    exempted: issue.exempted === true,
  }
}

/**
 * Run the local implementation for one corpus case.
 * @param {object} row - one corpus entry.
 */
function localVerdict(row) {
  try {
    return normalise(evaluatePluginCompatibility(row.manifest, {
      exemptions: row.exemptions ?? {},
      runtimeVersion: row.runtimeVersion,
    }))
  } catch (error) {
    return { throws: String(error.message ?? error).split('\n')[0] }
  }
}

test('the corpus was captured from the official package, and says so', () => {
  // Without this the file could quietly become a copy of the local behaviour, which is the one thing it must
  // not be.
  assert.equal(CORPUS.capturedFrom.package, '@deepseek-ai/dsh-app-boot')
  assert.match(CORPUS.capturedFrom.note, /official implementation/u)
  assert.ok(CORPUS.cases.length >= 40, `expected at least 40 cases, saw ${CORPUS.cases.length}`)
})

test('the local judgement agrees with the official one on every corpus case', () => {
  const mismatches = []
  for (const row of CORPUS.cases) {
    const local = localVerdict(row)
    const same = row.expect.throws !== undefined
      ? typeof local.throws === 'string'
      : typeof local.throws !== 'string'
        && local.compatible === row.expect.compatible
        && JSON.stringify(local.requirements ?? {}) === JSON.stringify(row.expect.requirements ?? {})
        && (local.exempted ?? false) === (row.expect.exempted ?? false)
    if (!same) {
      mismatches.push(`${row.label}\n      official: ${JSON.stringify(row.expect)}\n      local:    ${JSON.stringify(local)}`)
    }
  }
  assert.deepEqual(mismatches, [], `\n  ${mismatches.join('\n  ')}`)
})

test('the corpus covers the cases the remediation asked for', () => {
  // A corpus that agrees because it stopped asking anything is worse than no corpus.
  const labels = CORPUS.cases.map((row) => row.label).join('\n')
  for (const required of [
    /engines\.dsh is not a string/u,
    /0\.x caret/u,
    /workspace caret/u,
    /workspace tilde/u,
    /workspace star/u,
    /workspace is not a range/u,
    /peers are ignored/u,
    /non-dsh peer is ignored/u,
    /empty string never matches/u,
    /star/u,
    /privilege|prerelease|Prerelease/u,
    /exemption hit/u,
    /exemption for another version/u,
  ]) {
    assert.match(labels, required, `the corpus must still cover ${required}`)
  }
})

test('a wrong expectation is caught, not tolerated', () => {
  // Proving the assertion above can fail. A corpus comparison that passes because it compares nothing is the
  // failure mode worth guarding against here.
  const broken = {
    ...CORPUS.cases.find((row) => row.label.startsWith('engines: caret within the line')),
  }
  broken.expect = { compatible: false, requirements: { 'engines.dsh': '^0.2.0' }, exempted: false }
  const local = localVerdict(broken)
  assert.notDeepEqual(local, broken.expect, 'a deliberately wrong expectation must not match the local result')
})

test('the warning text names the exemption remedy, because a reader will look for it', () => {
  const issue = evaluatePluginCompatibility(
    { name: 'p', version: '1.0.0', engines: { dsh: '^0.1.0-rc.6' } },
    { runtimeVersion: '0.2.2-rc.1' },
  )
  assert.ok(issue, 'this manifest must be rejected')
  const warning = pluginCompatibilityWarning(issue)
  assert.match(warning, /dsh plugin allow-version|plugin manager/u)
  assert.match(warning, /Exact-version exemption: not active/u)
})