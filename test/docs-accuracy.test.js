import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The README has drifted from the shipped package more than once: a declared host range the package had not
// used for releases, a test count that stopped being true the moment someone added a test, and a claim about
// an official package that the official package contradicts. These assertions are cheap and they catch
// exactly that class of mistake.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))

/** Read a repository file. */
const read = (path) => readFileSync(`${ROOT}/${path}`, 'utf8')

/** Both READMEs, which must say the same thing about the same facts. */
const READMES = ['README.md', 'docs/README.zh.md']

test('every declared engines.dsh range in the READMEs matches package.json', () => {
  // A reader who trusts a stale range will believe their host is supported when the package says otherwise.
  const declared = pkg.engines.dsh
  assert.equal(typeof declared, 'string', 'package.json must declare engines.dsh')
  for (const file of READMES) {
    const text = read(file)
    const ranges = [...text.matchAll(/`?(>=?\s*[\d.]+-?[\w.]*\s*<\s*[\d.]+-?[\w.]*)`?/gu)]
      .map((match) => match[1].trim())
      .filter((range) => /<\s*0\.3\.0-0$/u.test(range))
    assert.ok(ranges.length > 0, `${file} no longer mentions a host range at all`)
    for (const range of ranges) {
      assert.equal(range, declared, `${file} states a host range that package.json does not: ${range}`)
    }
  }
})

test('neither README states a test count', () => {
  // "23 个单元测试" was true once. It is the kind of number that is wrong the next day and nobody notices.
  for (const file of READMES) {
    const text = read(file)
    assert.doesNotMatch(text, /\d+\s*个单元测试/u, `${file} states a unit-test count, which expires`)
    assert.doesNotMatch(text, /\d+\s*unit tests?/iu, `${file} states a unit-test count, which expires`)
    assert.doesNotMatch(text, /\b\d+\s*tests?\s+(?:pass|are|cover)/iu, `${file} states a test count, which expires`)
  }
})

test('the README does not claim the official plugin manager lacks version selection', () => {
  // @deepseek-ai/dsh-plugin-manager@0.2.2-rc.1 exports listVersions, updateBundle, listVersionExemptions and
  // setVersionExemption. Saying it has no version picker sends readers to the wrong conclusion about both
  // products.
  for (const file of READMES) {
    const text = read(file)
    assert.doesNotMatch(text, /no version picker/iu, `${file} understates the official manager`)
    assert.doesNotMatch(text, /没有\s*\n?版本选择\/升级动作/u, `${file} understates the official manager`)
  }
  // The precise gap is still stated, in both.
  assert.match(read('README.md'), /judges a plugin against the host that is running/u)
  assert.match(read('docs/README.zh.md'), /只按\*\*正在运行的那一个宿主\*\*判断/u)
})

test('the upgrade advice points at the line that is maintained', () => {
  // Telling a reader to reach 2.1.3 sends them to a version that no longer receives fixes.
  for (const file of READMES) {
    const text = read(file)
    assert.doesNotMatch(text, /请升级到 2\.1\.3/u, `${file} recommends reaching 2.1.3`)
    assert.doesNotMatch(text, /Running anything below 2\.1\.3\? Upgrade/u, `${file} recommends reaching 2.1.3`)
  }
  assert.match(read('docs/README.zh.md'), /请使用最新的 3\.x/u)
})

test('no development document contains a machine-specific absolute path', () => {
  // A path from the author's disk is wrong on every other machine, including the author's next one.
  const development = read('DEVELOPMENT.md')
  assert.doesNotMatch(development, /[A-Za-z]:\\/u, 'DEVELOPMENT.md contains a Windows absolute path')
  assert.doesNotMatch(development, /\/(?:home|Users)\/[a-z0-9_-]+\//iu, 'DEVELOPMENT.md contains an absolute home path')
  assert.match(development, /git worktree list/u, 'DEVELOPMENT.md should say how to find the worktrees instead')
})