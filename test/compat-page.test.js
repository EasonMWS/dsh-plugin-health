import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCompatPage } from '../src/compat/page.js'

// The page is the only form of this data a person can be linked to, so it has to be correct on its
// own: self-contained, honest about what a tick means, and readable without JavaScript.

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
  assert.match(html, /rejected by 2|rejected by 1/u)
  assert.match(html, /data-bad="1"/u)
})

test('a tick does not claim the plugin works, and the page says so', () => {
  const html = renderCompatPage(matrix())
  // The distinction matters: the gate admits the plugin, nothing more.
  assert.match(html, /does not mean the plugin\s+works/iu)
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
  // No results at all: the cell must read as unknown, not as a tick.
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
  assert.match(html, /0\.2\.1-rc\.5<\/strong> — 1 of 2 plugins are rejected \(1 accepted\)/u)
})

test('categories come from the catalog and reach both the row and the filter', () => {
  const catalog = new Map([['dsh-good', { category: 'ui' }], ['dsh-bad', { category: 'memory' }]])
  const html = renderCompatPage(matrix(), { catalog })
  assert.match(html, /data-cat="ui"/u)
  assert.match(html, /data-cat="memory"/u)
  // Both must be selectable, or the column is decorative.
  assert.match(html, /<option value="ui">ui<\/option>/u)
  assert.match(html, /<option value="memory">memory<\/option>/u)
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
  assert.doesNotMatch(html, /undefined/u)
  assert.match(html, /data-released=""/u)
})