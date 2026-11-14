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
// The README has drifted from the shipped package twice now: once claiming 1.4.0 for a 1.5.0 build,
// once still telling readers to upgrade to 1.1.0 after 2.1.3 had shipped two more advisories. These
// assertions are cheap and they catch exactly that class of mistake.

const readmeEn = readFileSync(new URL("../README.md", import.meta.url), "utf8")
const readmeZh = readFileSync(new URL("../docs/README.zh.md", import.meta.url), "utf8")
const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
const { major } = { major: pkgVersion.split(".")[0] }

test('both READMEs document the same feature set', () => {
  // Every capability the package ships has to be described in both, or the Chinese page turns into a
  // description of an older product.
  const features = [
    [/DSH_PLUGIN_HEALTH_NO_UPDATE/u, 'the update-check opt-out'],
    [/Community compatibility|社区兼容表/u, 'the link to the public table'],
    [/Check for updates|检查更新/u, 'the on-demand update check'],
  ]
  for (const [pattern, label] of features) {
    assert.match(readmeEn, pattern, `README.md is missing ${label}`)
    assert.match(readmeZh, pattern, `docs/README.zh.md is missing ${label}`)
  }
})

test('the security section names every advisory, not just the first one', () => {
  for (const id of ['GHSA-vj8q-543v-9hw5', 'GHSA-52w2-cq6j-xhg7']) {
    assert.match(readmeEn, new RegExp(id, 'u'), `README.md must cite ${id}`)
    assert.match(readmeZh, new RegExp(id, 'u'), `docs/README.zh.md must cite ${id}`)
  }
})

test('the security section does not stop at a superseded version', () => {
  // "Running 1.0.3 or earlier? Upgrade to 1.1.0" was true in 1.1.0 and misleading by 2.1.3.
  assert.doesNotMatch(readmeEn, /Running 1\.\d+\.\d+ or earlier\? Upgrade\.\*\* 1\./u,
    'the upgrade advice must point at the current line')
  assert.doesNotMatch(readmeZh, /还在用 1\.\d+\.\d+ 或更早？请升级。\*\* 1\./u)
  // The current line has to be named somewhere in the security section.
  assert.match(readmeEn, new RegExp(`\\*\\*${pkgVersion.replace(/\./gu, '\\.')}\\*\\*|2\\.1\\.3`, 'u'))
})

test('the promises section matches the shipped major version', () => {
  const section = new RegExp(`## What ${major}\\.x promises|## ${major}\\.x 承诺什么`, 'u')
  assert.match(readmeEn, section, `README.md must document what ${major}.x freezes`)
  assert.match(readmeZh, section)
})

test('every internal anchor resolves to a heading', () => {
  const slugify = (heading) => heading.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/gu, '')
    .replace(/\s+/gu, '-')
  for (const [name, text] of [['README.md', readmeEn], ['docs/README.zh.md', readmeZh]]) {
    const headings = new Set([...text.matchAll(/^#{1,6} (.+)$/gmu)].map((m) => slugify(m[1].trim())))
    for (const link of new Set([...text.matchAll(/\]\(#([^)]+)\)/gu)].map((m) => m[1]))) {
      assert.ok(headings.has(link), `${name}: #${link} points at no heading`)
    }
  }
})

// A published site nobody can find is the same as no site. These are the bare minimum for a search
// engine and a link preview, and they were all missing before 2.1.6: no description on the landing
// page, no Open Graph tags on either page, no sitemap, no robots.txt.

test('the landing page carries the metadata a search result needs', () => {
  const source = readFileSync(new URL('../src/index/build.js', import.meta.url), 'utf8')
  for (const [label, pattern] of [
    ['a description', /<meta name="description" content=/u],
    ['a canonical URL', /<link rel="canonical" href=/u],
    ['og:title', /property="og:title"/u],
    ['og:description', /property="og:description"/u],
    ['og:url', /property="og:url"/u],
    ['a twitter card', /name="twitter:card"/u],
  ]) {
    assert.match(source, pattern, `the landing page is missing ${label}`)
  }
  // The description has to lead with the symptom people search for, not with the artefact's name.
  assert.match(source, /stopped loading|plugins still load/u)
})

test('the compatibility page carries the same metadata', () => {
  const source = readFileSync(new URL('../src/compat/page.js', import.meta.url), 'utf8')
  for (const [label, pattern] of [
    ['a description', /<meta name="description" content=/u],
    ['a canonical URL', /<link rel="canonical" href=/u],
    ['og:title', /property="og:title"/u],
    ['og:url', /property="og:url"/u],
  ]) {
    assert.match(source, pattern, `the compatibility page is missing ${label}`)
  }
})

test('the deploy publishes a sitemap and robots.txt', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish-index.yml', import.meta.url), 'utf8')
  assert.match(workflow, /site\/sitemap\.xml/u, 'no sitemap is written')
  assert.match(workflow, /site\/robots\.txt/u, 'no robots.txt is written')
  // The namespace is sitemaps.org; sitemap.org does not serve that schema and crawlers ignore it.
  assert.match(workflow, /http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9/u)
  assert.doesNotMatch(workflow, /xmlns="http:\/\/www\.sitemap\.org\//u, 'typo in the sitemap namespace')
})

test('both READMEs point at the site above the fold', () => {
  // A reader who will not install yet should not have to scroll to find the table.
  for (const [name, file] of [['README.md', '../README.md'], ['docs/README.zh.md', '../docs/README.zh.md']]) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    const firstScreen = text.split('\n').slice(0, 40).join('\n')
    assert.match(firstScreen, /easonmws\.github\.io\/dsh-plugin-health\/compat\//u,
      `${name} does not link to the compatibility table within the first screen`)
  }
})

test('the install command names a profile that the app actually loads', () => {
  // Both READMEs said `--profile web`. The code's own default is desktop then web, and the desktop
  // app installs to `desktop`, so a reader on the desktop app put the plugin into a profile their
  // app never loads — and then saw no panel, with nothing on the page explaining why.
  for (const file of ['../README.md', '../docs/README.zh.md']) {
    const doc = readFileSync(new URL(file, import.meta.url), 'utf8')
    const commands = [...doc.matchAll(/dsh plugin --profile (\w+) add dsh-plugin-health/gu)].map((m) => m[1])
    assert.ok(commands.length > 0, `${file} must show the install command`)
    for (const profile of commands) {
      // Any profile is fine except the one a desktop user cannot see.
      assert.notEqual(profile, 'web', `${file}: --profile web is the wrong default; the desktop app reads the desktop profile`)
    }
    // The line explaining how to choose must not go missing either.
    assert.match(doc, /desktop app uses|桌面版用/u, `${file} must say which profile the desktop app uses`)
  }
})

test('the READMEs agree with the code about the default profile', () => {
  // The code falls back to desktop, then web. If that changes, the docs have to change with it.
  const source = readFileSync(new URL('../src/repair/inspect.js', import.meta.url), 'utf8')
  const match = source.match(/profiles\.includes\('(\w+)'\)/u)
  assert.ok(match, 'the default-profile logic moved; update this test and the READMEs together')
  assert.equal(match[1], 'desktop')
})
