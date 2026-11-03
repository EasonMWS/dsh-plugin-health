import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The READMEs are read in two places with different base URLs: the repository page resolves relative
// paths, npm does not. An image written as `docs/images/x.png` therefore works on GitHub and 404s on
// npmjs.com, which is where most people first see the package. Absolute URLs are the only form that
// renders in both.

const READMES = ['README.md', 'docs/README.zh.md']

/** README text with fenced code blocks removed — examples inside them are not real references. */
function proseOf(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  return text.replace(/```[\s\S]*?```/gu, '')
}

for (const file of READMES) {
  test(`${file}: every local image is referenced by absolute URL`, () => {
    const text = proseOf(file)
    const relative = [...text.matchAll(/!\[[^\]]*\]\((?!https?:)([^)]+)\)/gu)].map((m) => m[1])
    assert.deepEqual(relative, [], `relative image paths break the npm page: ${relative.join(', ')}`)
  })

  test(`${file}: referenced screenshots exist in the repository`, () => {
    const text = proseOf(file)
    const images = [...text.matchAll(/!\[[^\]]*\]\(https:\/\/raw\.githubusercontent\.com\/[^)]*\/docs\/images\/([^)\\/]+)\)/gu)]
      .map((m) => m[1])
    assert.ok(images.length > 0, 'the README should show the UI')
    for (const image of images) {
      const path = new URL(`../docs/images/${image}`, import.meta.url)
      assert.doesNotThrow(() => readFileSync(path), `missing screenshot: docs/images/${image}`)
    }
  })

  test(`${file}: the status line matches package.json`, () => {
    const text = proseOf(file)
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.ok(text.includes(`\`${pkg.version}\``), `README is not on version ${pkg.version}`)
  })
}

test('the Chinese README does not reference English screenshots', () => {
  const text = proseOf('docs/README.zh.md')
  const images = [...text.matchAll(/docs\/images\/([a-z-]+?)(\.zh)?\.png/gu)].map((m) => ({ name: m[1], zh: m[2] !== undefined }))
  const wrong = images.filter((image) => !image.zh)
  assert.deepEqual(wrong.map((image) => image.name), [], 'a Chinese reader should not get English screenshots')
})

test('only one README sits in the package root, so npm publishes a predictable one', () => {
  // npm fills the packument's `readme` from whichever readme `readdir` returns first, and that order
  // is arbitrary on Linux. With two candidates the published page has been Chinese, and could flip to
  // English on any release. One candidate removes the coin toss.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const candidates = readdirSync(root).filter((name) => /^readme(\.[a-z]+)*$/iu.test(name))
  assert.deepEqual(candidates, ['README.md'], `expected only README.md in the package root, found ${candidates.join(', ')}`)
})

test('both READMEs link to each other', () => {
  for (const file of ['README.md', 'docs/README.zh.md']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(text, /\[English\]\(https:\/\/github\.com\/EasonMWS\/dsh-plugin-health\/blob\/main\/README\.md\)/u, `${file} lacks an English link`)
    assert.match(text, /\[中文\]\(https:\/\/github\.com\/EasonMWS\/dsh-plugin-health\/blob\/main\/docs\/README\.zh\.md\)/u, `${file} lacks a Chinese link`)
  }
})