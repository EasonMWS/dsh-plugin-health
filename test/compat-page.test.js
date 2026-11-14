import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCompatPage } from '../src/compat/page.js'

// The page is the only form of this data a person can be linked to, so it has to be correct on its
// own: self-contained, honest about what a tick means, readable without JavaScript, and translatable
// without re-rendering the table.

function matrix({ hosts = ['0.2.1-rc.5'], plugins } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-03T11:53:00.000Z',
    hosts,
    plugins: plugins ?? [
      {
        name: 'dsh-good', version: '1.0.0', source: { type: 'npm' },
        results: { '0.2.1-rc.5': { compatible: true } },
        summary: { compatible: 1, incompatible: 0, errors: 0 },
      },
      {
        name: 'dsh-bad', version: '0.4.0', source: { type: 'npm' },
        results: { '0.2.1-rc.5': { compatible: false, requirements: { 'engines.dsh': '0.2.1-rc.4' } } },
        summary: { compatible: 0, incompatible: 1, errors: 0 },
      },
    ],
  }
}

/** The embedded bilingual dictionary, as the page itself would read it. */
function embeddedDict(html) {
  const match = html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/u)
  assert.ok(match, 'the page must carry its dictionary inline')
  return JSON.parse(match[1])
}

test('the page is self-contained: no external stylesheet or script', () => {
  const html = renderCompatPage(matrix())
  assert.doesNotMatch(html, /<link[^>]+stylesheet/iu)
  assert.doesNotMatch(html, /<script[^>]+src=/iu)
  assert.match(html, /<style>/u)
})

test('every plugin becomes a row, with the host versions as columns', () => {
  const html = renderCompatPage(matrix())
  assert.match(html, /data-name="dsh-good"/u)
  assert.match(html, /data-name="dsh-bad"/u)
  assert.match(html, /<th scope="col" class="c">0\.2\.1-rc\.5<\/th>/u)
})

test('a rejected plugin is marked in the row and counted', () => {
  const html = renderCompatPage(matrix())
  assert.match(html, /data-i18n="rejectedBy">rejected by<\/span> 1/u)
  assert.match(html, /data-bad="1"/u)
})

test('a tick does not claim the plugin works, and the page says so', () => {
  const html = renderCompatPage(matrix())
  // The distinction matters: the gate admits the plugin, nothing more.
  assert.match(html, /does not mean the plugin works/iu)
  assert.match(html, /not a security review/iu)
})

test('a plugin that was never checked is not presented as compatible', () => {
  const html = renderCompatPage(matrix({
    plugins: [{
      name: 'dsh-unchecked', version: '1.0.0',
      results: {},
      summary: { compatible: 0, incompatible: 0, errors: 0 },
    }],
  }))
  assert.match(html, /not tested|unknown/u)
  assert.doesNotMatch(html, /data-name="dsh-unchecked"[\s\S]{0,400}?class="c ok"/u)
})

test('plugin names are escaped, so a hostile name cannot inject markup', () => {
  const html = renderCompatPage(matrix({
    plugins: [{
      name: '<img src=x onerror=alert(1)>', version: '1.0.0',
      results: {}, summary: { compatible: 0, incompatible: 0, errors: 0 },
    }],
  }))
  assert.doesNotMatch(html, /<img src=x/u)
  assert.match(html, /&lt;img src=x/u)
})

test('the page carries a title and description for search engines', () => {
  const html = renderCompatPage(matrix(), { title: 'DSH plugin compatibility' })
  assert.match(html, /<title>DSH plugin compatibility/u)
  assert.match(html, /<meta name="description" content="[^"]{40,}/u)
})

test('an empty matrix still renders a valid page', () => {
  const html = renderCompatPage({ generatedAt: '2026-11-03T00:00:00.000Z', hosts: ['0.2.1-rc.5'], plugins: [] })
  assert.match(html, /<!doctype html>/u)
  assert.doesNotMatch(html, /data-name=/u)
})

test('the summary counts rejections per host version', () => {
  const html = renderCompatPage(matrix())
  // One of the two plugins is rejected on this host, and the summary has to say which way round.
  assert.match(html, /0\.2\.1-rc\.5<\/strong>[^\n]*data-ok="1">Rejected: 1 · Accepted: 1/u)
})

test('categories come from the catalog and reach both the row and the filter', () => {
  const catalog = new Map([['dsh-good', { category: 'ui' }], ['dsh-bad', { category: 'memory' }]])
  const html = renderCompatPage(matrix(), { catalog })
  assert.match(html, /data-cat="ui"/u)
  assert.match(html, /data-cat="memory"/u)
  // Both must be selectable, or the column is decorative.
  assert.match(html, /<option value="ui" data-cat-label="ui">ui<\/option>/u)
  assert.match(html, /<option value="memory" data-cat-label="memory">memory<\/option>/u)
})

test('a plugin with no catalog entry is marked uncategorized, not blank', () => {
  const html = renderCompatPage(matrix(), { catalog: new Map() })
  assert.match(html, /data-cat="uncategorized"/u)
  assert.doesNotMatch(html, /data-cat=""/u)
})

test('the publish date is shown and machine-sortable', () => {
  const doc = matrix()
  doc.plugins[0].publishedAt = '2026-10-17T11:51:49.327Z'
  const html = renderCompatPage(doc)
  assert.match(html, /data-released="2026-10-17"/u)
  assert.match(html, />2026-10-17</u)
})

test('a missing publish date renders as a placeholder rather than "undefined"', () => {
  const html = renderCompatPage(matrix())
  // Scope the check to the table: the inline script legitimately compares against `undefined`.
  const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'))
  assert.doesNotMatch(body, /undefined/u)
  assert.match(body, /data-released=""/u)
})

test('the top of the page states the total, the healthy count and the rejected count', () => {
  const html = renderCompatPage(matrix())
  // Two plugins, one accepted on every host, one rejected: the three numbers have to agree.
  assert.match(html, /<span class="n">2<\/span><span class="k" data-i18n="checked">/u)
  assert.match(html, /<span class="n">1<\/span><span class="k" data-i18n="healthy" data-pct="50">/u)
  assert.match(html, /<span class="n">1<\/span><span class="k" data-i18n="rejected" data-pct="50">/u)
})

test('a plugin that errors on a host is not counted as healthy', () => {
  const html = renderCompatPage(matrix({
    plugins: [{
      name: 'dsh-flaky', version: '1.0.0',
      results: { '0.2.1-rc.5': { compatible: null, error: 'registry timeout' } },
      summary: { compatible: 0, incompatible: 0, errors: 1 },
    }],
  }), {})
  assert.match(html, /<span class="n">0<\/span><span class="k" data-i18n="healthy"/u)
})

test('the page says where the data comes from, so a reader cannot mistake its scope', () => {
  const html = renderCompatPage(matrix())
  assert.match(html, /awesome-dsh-plugin/u)
  assert.match(html, /published npm manifests/u)
  assert.match(html, /omits GitHub repositories whose manifest could not be read/u)
  // The key claim: nothing is installed and no plugin code runs.
  assert.match(html, /Declaration checks read manifests only/u)
})

test('host labels keep their real casing in the per-host summary', () => {
  const html = renderCompatPage(matrix())
  assert.match(html, /<strong>0\.2\.1-rc\.5<\/strong>/u)
  assert.doesNotMatch(html, /<strong>0\.2\.1-RC\.5<\/strong>/u)
})

// --- language ------------------------------------------------------------------------------

test('the page ships both dictionaries and a toggle', () => {
  const html = renderCompatPage(matrix())
  const dict = embeddedDict(html)
  assert.ok(dict.en && dict.zh, 'both languages must be present')
  assert.match(html, /data-lang="en"/u)
  assert.match(html, /data-lang="zh"/u)
  // English is rendered into the markup so the first paint and a crawler both get real text.
  assert.match(html, /<h1 data-i18n="heading">DSH plugin compatibility<\/h1>/u)
})

test('every translatable string exists in both languages', () => {
  const dict = embeddedDict(renderCompatPage(matrix()))
  const enKeys = Object.keys(dict.en).filter((k) => k !== 'categories').sort()
  const zhKeys = Object.keys(dict.zh).filter((k) => k !== 'categories').sort()
  assert.deepEqual(zhKeys, enKeys, 'the two dictionaries must define the same keys')
})

test('every key the markup asks for is actually defined', () => {
  // A data-i18n pointing at a missing key renders the key itself, which is how "tallyStamp" once
  // appeared in the page header. Comparing the two dictionaries cannot catch that, because both
  // simply lack the key.
  const html = renderCompatPage(matrix(), { catalog: new Map([['dsh-good', { category: 'ui' }]]) })
  const dict = embeddedDict(html)
  const used = new Set([
    ...[...html.matchAll(/data-i18n="([^"]+)"/gu)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n-placeholder="([^"]+)"/gu)].map((m) => m[1]),
  ])
  assert.ok(used.size > 10, 'the scan should find the page strings')
  for (const key of used) {
    assert.ok(dict.en[key] !== undefined, `en dictionary is missing "${key}"`)
    assert.ok(dict.zh[key] !== undefined, `zh dictionary is missing "${key}"`)
  }
})

test('no Chinese string is left in the English dictionary or vice versa', () => {
  const dict = embeddedDict(renderCompatPage(matrix()))
  // A few keys are punctuation rather than prose, so "contains Chinese" is not a useful rule there.
  const symbolOnly = new Set(['shownOf', 'categories'])
  for (const key of Object.keys(dict.en)) {
    if (symbolOnly.has(key)) continue
    assert.doesNotMatch(dict.en[key], /[\u4e00-\u9fff]/u, `en.${key} must not contain Chinese`)
    assert.match(dict.zh[key], /[\u4e00-\u9fff]/u, `zh.${key} should be translated`)
  }
})

test('categories are translated, including the ones the catalog actually uses', () => {
  const dict = embeddedDict(renderCompatPage(matrix()))
  // ui, tools and session are the three most common; a missing label would show as a raw slug.
  for (const category of ['ui', 'tools', 'session', 'memory', 'security', 'uncategorized']) {
    assert.ok(dict.zh.categories[category], `zh category missing: ${category}`)
    assert.match(dict.zh.categories[category], /[\u4e00-\u9fff]/u, `zh category not translated: ${category}`)
  }
})

test('the embedded dictionary cannot terminate the script element early', () => {
  const html = renderCompatPage(matrix({
    plugins: [{
      name: 'dsh-</script><script>alert(1)</script>', version: '1.0.0',
      results: {}, summary: { compatible: 0, incompatible: 0, errors: 0 },
    }],
  }))
  const scripts = html.match(/<\/script>/gu) ?? []
  assert.equal(scripts.length, 2, 'only the dictionary and the behaviour script may close')
  assert.doesNotMatch(html, /<\/script><script>alert/u)
})
