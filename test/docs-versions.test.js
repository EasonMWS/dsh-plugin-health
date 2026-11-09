import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The author-facing entry points were pinned to releases from before the security advisory. Anyone who used
// `matrix-review.yml@v0.1.5`, or left `toolVersion` at its default, silently ran a build with the known
// issues still in it — and nothing in the repository said so.
//
// A one-time fix would drift back the moment someone copies an old snippet. These assertions are the thing
// that keeps it from drifting.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Read a repository file. */
function read(path) {
  return readFileSync(`${ROOT}${path}`, 'utf8')
}

/** Line number of an index, 1-based. */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** Files that describe how a plugin author runs the tool. */
function scannedFiles() {
  const files = ['/README.md', '/docs/README.zh.md', '/action.yml']
  for (const name of readdirSync(`${ROOT}/examples`)) {
    if (name.endsWith('.yml') || name.endsWith('.yaml')) files.push(`/examples/${name}`)
  }
  for (const name of readdirSync(`${ROOT}/.github/workflows`)) {
    if (name.endsWith('.yml') || name.endsWith('.yaml')) files.push(`/.github/workflows/${name}`)
  }
  return files
}

test('every reference to this repository\'s Action or reusable workflow asks for v3', () => {
  // `@v3` is a moving tag the maintainer fast-forwards on each 3.x release. Pinning a full version here means
  // authors stop receiving fixes without being told.
  const offenders = []
  for (const file of scannedFiles()) {
    const text = read(file)
    for (const match of text.matchAll(/(EasonMWS\/dsh-plugin-health(?:\/\.github\/workflows\/matrix-review\.yml)?)@v([\w.-]+)/gu)) {
      const [, target, ref] = match
      if (ref === '3') continue
      offenders.push(`${file}:${lineOf(text, match.index)} references ${target}@v${ref}, expected @v3`)
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`)
})

test('the matrix tool version resolves to the latest 3.x, wherever it is set', () => {
  // Two places set it: the default in the reusable workflow, and this repository's own call to it.
  const offenders = []
  for (const file of scannedFiles()) {
    const text = read(file)
    for (const match of text.matchAll(/^[ \t]*toolVersion:[ \t]*(\S[^\n]*)$/gmu)) {
      const value = match[1].trim().replace(/^['"]|['"]$/gu, '')
      if (value === '3') continue
      // A caller may pass an expression through env, but a literal has to be the range.
      if (value.startsWith('${{')) continue
      offenders.push(`${file}:${lineOf(text, match.index)} sets toolVersion to "${value}", expected '3'`)
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`)
})

test('the workflow defaults and the repository self-check are both actually present', () => {
  // The assertion above passes trivially if the keys are renamed away, so pin that they exist.
  const reusable = read('/.github/workflows/matrix-review.yml')
  assert.match(reusable, /^\s*toolVersion:\s*$/mu, 'matrix-review.yml must still declare the toolVersion input')
  assert.match(reusable, /default:\s*'3'/u, "matrix-review.yml must default toolVersion to '3'")

  const selfMatrix = read('/.github/workflows/self-matrix.yml')
  assert.match(selfMatrix, /toolVersion:\s*'3'/u, "self-matrix.yml must use toolVersion '3'")
})

test('the example a plugin author copies points at v3', () => {
  // This file is meant to be copied verbatim into another repository, so a stale ref here spreads.
  const example = read('/examples/dsh-compat.yml')
  assert.match(example, /matrix-review\.yml@v3/u, 'examples/dsh-compat.yml must reference the workflow at @v3')
  assert.doesNotMatch(example, /@v\d+\.\d+\.\d+/u, 'examples/dsh-compat.yml must not pin an exact version')
})

test('DEVELOPMENT.md says the v3 tag moves with every release', () => {
  // The tag is the mechanism the assertions above depend on. If the release notes stop saying to move it,
  // the tag silently falls behind and @v3 starts meaning an old release again.
  const text = read('/DEVELOPMENT.md')
  assert.match(text, /git tag -f v3/u, 'DEVELOPMENT.md must show moving the v3 tag')
  assert.match(text, /git push -f origin v3/u, 'DEVELOPMENT.md must show pushing the moved tag')
})