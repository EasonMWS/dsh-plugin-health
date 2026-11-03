import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The READMEs are read in two places with different base URLs: the repository page resolves relative
// paths, npm does not. An image written as `docs/images/x.png` therefore works on GitHub and 404s on
// npmjs.com, which is where most people first see the package. Absolute URLs are the only form that
// renders in both.

const READMES = ['README.md', 'README.zh.md']

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
  const text = proseOf('README.zh.md')
  const images = [...text.matchAll(/docs\/images\/([a-z-]+?)(\.zh)?\.png/gu)].map((m) => ({ name: m[1], zh: m[2] !== undefined }))
  const wrong = images.filter((image) => !image.zh)
  assert.deepEqual(wrong.map((image) => image.name), [], 'a Chinese reader should not get English screenshots')
})