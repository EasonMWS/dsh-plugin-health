import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INLINE_ROWS, STRINGS, renderCompatPage } from '../src/compat/page.js'
import { buildRows, shieldsDocument } from '../src/compat/rows.js'
import { loadVerify, updateHistory, writeCompatSite } from '../src/compat/artifacts.js'

const HOST = '0.2.2-rc.1'
const HOSTILE = '<img src=x onerror=alert(1)>'

function plugin(name, { compatible = true, declared = 'engines', range = '>=0.2.0-0 <0.3.0-0', fixHint } = {}) {
  return {
    name, version: '1.0.0', declared,
    declaredRanges: declared === 'engines' ? { 'engines.dsh': range } : {},
    results: { [HOST]: compatible ? { compatible: true } : { compatible: false, requirements: { 'engines.dsh': range }, ...(fixHint ? { fixHint } : {}) } },
    summary: { compatible: compatible ? 1 : 0, incompatible: compatible ? 0 : 1, errors: 0 },
  }
}

function matrix(plugins) {
  return { schemaVersion: 1, generatedAt: '2026-11-09T04:00:00.000Z', hosts: [HOST], hostRoles: { [HOST]: 'latest' }, plugins }
}

function verifyFile(directory, rows, conflicts = []) {
  const path = join(directory, 'verify.json')
  writeFileSync(path, JSON.stringify({ host: { version: HOST }, plugins: rows, conflicts }))
  return path
}

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-health-site-'))

test('rows carry the declaration source: an undeclared pass is not shown as a declared tick', () => {
  const rows = buildRows(matrix([plugin('declared'), plugin('quiet', { declared: 'none' })]))
  assert.deepEqual(rows.map((row) => row.s[0]), ['ok', 'none'])
  const html = renderCompatPage(matrix([plugin('quiet', { declared: 'none' })]))
  assert.match(html, /class="c none" title="no declaration: the host does not check it"/u)
})

test('rows anchor themselves and link to themselves', () => {
  const html = renderCompatPage(matrix([plugin('@scope/thing')]))
  assert.match(html, /<tr id="p-scope__thing"/u)
  assert.match(html, /<a class="name" href="#p-scope__thing">@scope\/thing<\/a>/u)
  assert.match(html, /copyLink/u, 'the copy-link control is wired in the client')
})

test('the headline counts the latest host and adds the next-build forecast', () => {
  const html = renderCompatPage(matrix([
    plugin('pinned', { range: '0.2.1-rc.5 || 0.2.2-rc.1' }),
    plugin('ranged'),
    plugin('broken', { compatible: false, range: '0.2.1-rc.5' }),
  ]))
  assert.match(html, /<div class="cell bad"><span class="n">1<\/span>/u)
  assert.match(html, /<div class="cell risk"><span class="n">1<\/span><span class="k" data-i18n="atRiskTally"/u)
})

test('the compatibility tally counts table entries, including unknown results', () => {
  const unknown = {
    ...plugin('unreadable'),
    results: { [HOST]: { compatible: null, error: 'lookup failed' } },
    summary: { compatible: 0, incompatible: 0, errors: 1 },
  }
  const html = renderCompatPage(matrix([plugin('declared'), plugin('quiet', { declared: 'none' }), unknown]))
  const markup = html.slice(0, html.indexOf('<script id="'))
  assert.match(markup, /<span class="n">3<\/span><span class="k" data-i18n="checked">compatibility table entries<\/span>/u)
  assert.match(markup, /entries with no recorded rejection on the latest host/u)
  assert.match(markup, /The table entry count includes rows with unknown results/u)
  assert.doesNotMatch(markup, /3 plugins (?:here|checked)|The plugin list is the awesome-dsh-plugin community catalog/u)
  assert.equal(STRINGS.zh.checked, '兼容表收录条目')
  assert.match(STRINGS.zh.source, /兼容表收录条目含结果未知的行/u)
  assert.doesNotMatch(STRINGS.zh.source, /这里是 \{n\} 个/u)
})

test('the legend explains the levels and says it is not a security review', () => {
  const html = renderCompatPage(matrix([plugin('a')]))
  assert.match(html, /<div class="legend">/u)
  assert.match(html, /None of this is a security review/u)
  assert.match(html, /&quot;boots&quot; means every entry of the plugin activated/u)
})

test('only the first rows are inline; the rest is rows.json', () => {
  const many = Array.from({ length: INLINE_ROWS + 30 }, (_, index) => plugin(`plugin-${String(index).padStart(4, '0')}`))
  const html = renderCompatPage(matrix(many))
  assert.equal((html.match(/<tr id="p-/gu) ?? []).length, INLINE_ROWS)
  assert.match(html, /"rowsUrl":"rows.json"/u)
  assert.match(html, /id="partial"/u)
})

test('verify results reach the latest column, with evidence, failure and bypass', () => {
  const directory = tmp()
  const path = verifyFile(directory, [
    { name: 'boots', version: '1.0.0', level: 'V3', result: 'results/boots.json' },
    { name: 'stuck', version: '1.0.0', level: 'V2', failure: { kind: 'missing-service' }, result: 'results/stuck.json' },
    { name: 'stale', version: '1.0.0', level: null, bypassed: true, bypass: { level: 'V3' }, failure: { kind: 'gate-rejected' } },
    { name: 'old', version: '0.9.0', level: 'V3' },
  ])
  const loaded = loadVerify(path)
  const rows = buildRows(matrix([plugin('boots'), plugin('stuck'), plugin('stale', { compatible: false, range: '0.2.1-rc.5' }), plugin('old')]), loaded)
  const byName = Object.fromEntries(rows.map((row) => [row.n, row]))
  assert.equal(byName.boots.l, 'V3')
  assert.equal(byName.boots.e, `../verify/${HOST}/results/boots.json`)
  assert.equal(byName.stuck.k, 'missing-service')
  assert.equal(byName.stale.b, 'V3')
  assert.equal(byName.old.l, null, 'a result for another version does not describe this one')
  assert.equal(shieldsDocument(byName.stale, matrix([])).message, 'rejected · boots if exempted', 'a stale declaration is not the same finding as broken code')
  const html = renderCompatPage(matrix([plugin('boots')]), loaded)
  assert.match(html, /<span class="lvl lvl-V3">boots<\/span>/u)
})

test('a verify file is validated, not trusted: odd levels, kinds and paths are dropped', () => {
  const directory = tmp()
  const path = verifyFile(directory, [
    { name: 'x', level: 'V9', failure: { kind: '<b>evil</b>' }, result: '../../etc/passwd' },
    { name: 42 },
  ])
  const { verify } = loadVerify(path)
  assert.equal(verify.rows.size, 1)
  const row = verify.rows.get('x')
  assert.equal(row.level, null)
  assert.equal(row.failure.kind, 'bevilb', 'only [a-z-] survives')
  assert.equal(row.result, undefined)
})

test('hostile names and failure details never reach the HTML as markup', () => {
  const directory = tmp()
  const path = verifyFile(directory, [{ name: HOSTILE, version: '1.0.0', level: 'V2', failure: { kind: 'unknown' } }],
    [{ kind: 'tool-name', name: HOSTILE, plugins: [`${HOSTILE}@1.0.0`, 'other@1.0.0'] }])
  const html = renderCompatPage(matrix([plugin(HOSTILE)]), loadVerify(path))
  assert.doesNotMatch(html, /<img src=x/u)
  assert.doesNotMatch(html, /onerror=alert\(1\)>/u)
  // The client never builds markup from data.
  const script = html.slice(html.lastIndexOf('<script>'))
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/u)
})

test('predicted conflicts are attached to every plugin involved', () => {
  const directory = tmp()
  const path = verifyFile(directory, [], [{ kind: 'tool-name', name: 'web_search', plugins: ['a@1.0.0', '@s/b@2.0.0', 'c@1.0.0'] }])
  const { conflicts } = loadVerify(path)
  assert.deepEqual(conflicts.get('@s/b'), [{ kind: 'tool-name', name: 'web_search', with: ['a', 'c'] }])
})

test('the site writes rows.json, a document and a shields endpoint per plugin', () => {
  const out = tmp()
  const doc = matrix([plugin('@scope/thing'), plugin('broken', { compatible: false, range: '^0.1.0', fixHint: { reason: 'caret-zero', suggested: { 'engines.dsh': '>=0.1.0 <0.3.0-0' }, crossesLine: true, suggestion: true } })])
  const result = writeCompatSite(doc, out, {})
  assert.equal(result.rows, 2)
  const rows = JSON.parse(readFileSync(join(out, 'rows.json'), 'utf8'))
  assert.equal(rows.length, 2)
  const document = JSON.parse(readFileSync(join(out, 'p', 'broken.json'), 'utf8'))
  assert.equal(document.page, 'https://easonmws.github.io/dsh-plugin-health/compat/#p-broken')
  assert.equal(document.hosts[HOST].fixHint.reason, 'caret-zero')
  assert.match(document.caveat, /Not a security review/u)
  const shield = JSON.parse(readFileSync(join(out, 'shields', 'scope__thing.json'), 'utf8'))
  assert.deepEqual(shield, { schemaVersion: 1, label: `dsh ${HOST}`, message: 'accepted', color: 'green' })
  assert.ok(existsSync(join(out, 'index.html')))
})

test('badges say the strongest true thing and no more', () => {
  const row = (overrides) => ({ s: ['ok'], l: null, f: null, b: null, ...overrides })
  const doc = matrix([])
  assert.equal(shieldsDocument(row({ l: 'V3' }), doc).message, 'boots')
  assert.equal(shieldsDocument(row({}), doc).message, 'accepted')
  assert.equal(shieldsDocument(row({ f: ['0.2.2-rc.2'] }), doc).color, 'yellow')
  assert.equal(shieldsDocument(row({ s: ['none'] }), doc).message, 'undeclared')
  assert.equal(shieldsDocument(row({ s: ['bad'], b: 'V3' }), doc).message, 'rejected · boots if exempted')
})

test('history: a second day produces events, and a rerun on the same day does not duplicate them', () => {
  const directory = tmp()
  updateHistory(matrix([plugin('a', { compatible: false, range: '0.2.1-rc.5' }), plugin('b')]), directory, { date: '2026-11-08' })
  const day2 = matrix([{ ...plugin('a'), version: '1.0.1' }, plugin('b', { compatible: false, range: '0.2.1-rc.5' })])
  const first = updateHistory(day2, directory, { date: '2026-11-09' })
  assert.deepEqual(first.events.map((event) => [event.name, event.kind]), [['a', 'fixed'], ['b', 'broken']])
  const again = updateHistory(day2, directory, { date: '2026-11-09' })
  assert.equal(again.events.length, 2)
  assert.equal(again.summary.get('a').lastFixed, '2026-11-09')
  const rows = buildRows(day2, { history: again.summary })
  assert.deepEqual(rows.find((row) => row.n === 'b').t, { since: '2026-11-09', state: 'bad', fixed: null })
})

test('C3: a GitHub-only row is marked on the page and in its document', () => {
  const doc = matrix([{ ...plugin('gh-only'), source: 'github' }])
  const html = renderCompatPage(doc)
  assert.match(html, /data-i18n="githubOnly">GitHub only: judged from the default branch/u)
  const out = tmp()
  writeCompatSite(doc, out, {})
  assert.equal(JSON.parse(readFileSync(join(out, 'p', 'gh-only.json'), 'utf8')).source.kind, 'github')
})
