/**
 * Check the local compatibility mirror against the official implementation.
 *
 * `src/compat/evaluate.js` is a copy of the host's judgement. The copy exists because the tool has to run
 * offline and must not depend on an official package — but a copy that silently diverges makes every
 * compatibility verdict wrong, including the whole published page.
 *
 * Usage:
 *   node scripts/compat-drift.js <dir-with-@deepseek-ai/dsh-app-boot> [more dirs...]
 *
 * Exit codes: 0 when every official build agrees with the local one, 1 on any difference, 2 when an
 * installed build does not export the function at all (older releases predate it — that is reported, not
 * treated as a failure).
 * @module scripts/compat-drift
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { evaluatePluginCompatibility } from '../src/compat/evaluate.js'

const PACKAGE = '@deepseek-ai/dsh-app-boot'

/**
 * The directory holding the installed official package under a given root.
 * @param {string} root
 * @returns {string|null}
 */
function packageDirectory(root) {
  const candidates = [
    join(root, 'node_modules', ...PACKAGE.split('/')),
    join(root, ...PACKAGE.split('/')),
    root,
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

/**
 * Confirm from the type declarations that the function this script calls is really exported, and report the
 * declared signature. Calling a function because an old note said it exists is how a drift check ends up
 * comparing against a stub.
 *
 * @param {string} directory - installed package directory.
 * @returns {{checked: boolean, signature?: string, reason?: string}}
 */
function readDeclaredSignature(directory) {
  const declaration = join(directory, 'lib', 'types', 'plugin-compatibility.d.ts')
  if (!existsSync(declaration)) return { checked: false, reason: 'no lib/types/plugin-compatibility.d.ts' }
  const text = readFileSync(declaration, 'utf8')
  const match = text.match(/export declare function evaluatePluginCompatibility\(([^)]*)\)\s*:\s*([^;]+);/u)
  if (match === null) return { checked: false, reason: 'the declaration does not declare evaluatePluginCompatibility' }
  return { checked: true, signature: `evaluatePluginCompatibility(${match[1].trim()}): ${match[2].trim()}` }
}

/**
 * Turn either implementation's result into one comparable shape.
 * @param {object|undefined} issue
 */
function normalise(issue) {
  if (issue === undefined) return { compatible: true }
  return {
    compatible: false,
    requirements: issue.requirements ?? {},
    exempted: issue.exempted === true,
  }
}

/**
 * Run one case against the official function.
 *
 * The official signature is positional (`manifest, exemptions, runtimeVersion`); the local one takes an
 * options object. Adapting here rather than in the mirror keeps the mirror's shape convenient for callers.
 *
 * @param {Function} evaluate
 * @param {object} row - one corpus case.
 */
function officialVerdict(evaluate, row) {
  try {
    return normalise(evaluate(row.manifest, row.exemptions, row.runtimeVersion))
  } catch (error) {
    return { throws: String(error.message ?? error).split('\n')[0] }
  }
}

/** @param {object} row - one corpus case. */
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

/**
 * Are two normalised verdicts the same?
 *
 * A throw only has to match on "it threw": error wording is not part of the contract, and pinning it would
 * make every release fail on a copy edit.
 * @param {object} left
 * @param {object} right
 */
function sameVerdict(left, right) {
  if (left.throws !== undefined || right.throws !== undefined) {
    return (left.throws !== undefined) === (right.throws !== undefined)
  }
  return left.compatible === right.compatible
    && JSON.stringify(left.requirements) === JSON.stringify(right.requirements)
    && left.exempted === right.exempted
}

/**
 * Compare every corpus case against one installed official build.
 * @param {string} target - directory argument.
 * @param {object} corpus
 * @returns {Promise<{ok: boolean, skipped?: string, version?: string, differences: string[]}>}
 */
async function compare(target, corpus) {
  const directory = packageDirectory(resolve(target))
  if (directory === null) return { ok: false, skipped: `no ${PACKAGE} under ${target}`, differences: [] }

  const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version
  const declared = readDeclaredSignature(directory)
  if (declared.checked !== true) {
    return { ok: true, skipped: `${version}: ${declared.reason}; nothing to compare`, version, differences: [] }
  }
  console.log(`  ${PACKAGE}@${version}`)
  console.log(`    declared: ${declared.signature}`)

  const module = await import(pathToFileURL(join(directory, 'lib', 'index.js')).href)
  if (typeof module.evaluatePluginCompatibility !== 'function') {
    return { ok: true, skipped: `${version}: the build does not export the function`, version, differences: [] }
  }

  const differences = []
  for (const row of corpus.cases) {
    const official = officialVerdict(module.evaluatePluginCompatibility, row)
    const local = localVerdict(row)
    if (!sameVerdict(official, local)) {
      differences.push(`${row.label}\n      official: ${JSON.stringify(official)}\n      local:    ${JSON.stringify(local)}`)
    }
  }
  return { ok: differences.length === 0, version, differences }
}

// ---------- command line ----------
async function main() {
  const targets = process.argv.slice(2)
  if (targets.length === 0) {
    console.error('usage: node scripts/compat-drift.js <dir-with-dsh-app-boot> [...]')
    return 2
  }
  const corpus = JSON.parse(readFileSync(new URL('../test/fixtures/compat-corpus.json', import.meta.url), 'utf8'))
  console.log(`  corpus: ${corpus.cases.length} cases`)

  let drift = 0
  let compared = 0
  for (const target of targets) {
    const result = await compare(target, corpus)
    if (result.skipped !== undefined) {
      console.log(`  skip: ${result.skipped}`)
      continue
    }
    compared += 1
    if (result.ok) {
      console.log(`  ok: ${result.version} agrees on all ${corpus.cases.length} cases`)
      continue
    }
    drift += result.differences.length
    console.log(`  DRIFT: ${result.version}`)
    for (const difference of result.differences) console.log(`    · ${difference}`)
  }

  if (compared === 0) {
    console.log('  nothing was compared; every target was skipped')
    return 2
  }
  console.log(drift === 0 ? '\n  no drift' : `\n  ${drift} difference(s)`)
  return drift === 0 ? 0 : 1
}

process.exitCode = await main()