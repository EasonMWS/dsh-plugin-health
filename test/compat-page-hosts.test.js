import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCompatPage } from '../src/compat/page.js'

// A2: the headline has to describe the host people actually run. Before this, a plugin counted as rejected
// if any column rejected it — and one of the columns was an outdated prerelease. The number on the page then
// said the opposite of what a current user experiences.

/**
 * A matrix with two hosts, one of them the latest, and a plugin rejected only on the previous line.
 * @param {object} [options]
 */
function matrix({ hostRoles, hostsDropped } = {}) {
  const hosts = ['0.2.2-rc.1', '0.2.1-rc.5']
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-08T11:30:00.000Z',
    hosts,
    ...(hostRoles === undefined ? {} : { hostRoles }),
    ...(hostsDropped === undefined ? {} : { hostsDropped }),
    plugins: [
      {
        // Fine on latest, fine on the previous line.
        name: 'plugin-both',
        version: '1.0.0',
        results: { '0.2.2-rc.1': { compatible: true }, '0.2.1-rc.5': { compatible: true } },
        summary: { compatible: 2, incompatible: 0, errors: 0 },
      },
      {
        // The case the headline must not over-count: it works on latest and is rejected only on the old line.
        name: 'plugin-latest-only',
        version: '2.0.0',
        results: {
          '0.2.2-rc.1': { compatible: true },
          '0.2.1-rc.5': { compatible: false, requirements: { 'engines.dsh': '>=0.2.2-rc.1' } },
        },
        summary: { compatible: 1, incompatible: 1, errors: 0 },
      },
      {
        // Rejected on the host people run.
        name: 'plugin-broken',
        version: '3.0.0',
        results: {
          '0.2.2-rc.1': { compatible: false, requirements: { 'engines.dsh': '^0.1.0-rc.6' } },
          '0.2.1-rc.5': { compatible: false, requirements: { 'engines.dsh': '^0.1.0-rc.6' } },
        },
        summary: { compatible: 0, incompatible: 2, errors: 0 },
      },
    ],
  }
}

const ROLES = { '0.2.2-rc.1': 'latest', '0.2.1-rc.5': 'previous' }

/** The tally cells, in document order. */
function tallyCells(html) {
  const block = html.match(/<div class="tally">([\s\S]*?)<div class="controls">/u)
  assert.ok(block, 'the page must still have a tally')
  return [...block[1].matchAll(/<div class="cell(?: (\w+))?"><span class="n">(\d+)<\/span>/gu)]
    .map((match) => ({ cls: match[1] ?? 'total', n: Number(match[2]) }))
}

test('the headline counts rejection on the latest host, not on any host', () => {
  const html = renderCompatPage(matrix({ hostRoles: ROLES }))
  const cells = tallyCells(html)

  const bad = cells.find((cell) => cell.cls === 'bad')
  assert.equal(bad.n, 1, 'only plugin-broken is rejected on 0.2.2-rc.1')

  assert.match(html, /<span class="n">2<\/span><span class="k" data-i18n="acceptedOnLatest"[^>]*>entries with no recorded rejection on the latest host/u)

  // "Rejected by at least one" is still on the page, but it is not the headline.
  const any = cells.find((cell) => cell.cls === 'any')
  assert.equal(any.n, 2, 'plugin-latest-only and plugin-broken are rejected by at least one host')
  assert.ok(cells.indexOf(any) > cells.indexOf(bad), 'the any-host count must come after the latest count')

  assert.match(html, /rejected on the latest host/u)
  assert.match(html, /0\.2\.2-rc\.1/u)
})

test('the latest column is labelled with its role, in both languages', () => {
  const html = renderCompatPage(matrix({ hostRoles: ROLES }))
  // The role is a child of the header cell, so a reader cannot mistake the previous line for another
  // current host.
  assert.match(html, /0\.2\.2-rc\.1<span class="role">latest<\/span>/u)
  assert.match(html, /0\.2\.1-rc\.5<span class="role">previous line<\/span>/u)

  const dict = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/u)[1])
  assert.equal(dict.zh.roleLatest, '最新')
  assert.equal(dict.zh.rolePrevious, '上一版本线')
  assert.equal(dict.zh.rolePreview, '预览')
  assert.match(dict.zh.rejectedOnLatest, /最新版/u)
})

test('a dist-tag ahead of latest is labelled as preview, not as latest', () => {
  const html = renderCompatPage({
    schemaVersion: 1,
    generatedAt: '2026-11-08T11:30:00.000Z',
    hosts: ['0.2.2-rc.1', '0.2.3-rc.1'],
    hostRoles: { '0.2.2-rc.1': 'latest', '0.2.3-rc.1': 'next' },
    plugins: [{
      name: 'p', version: '1.0.0',
      results: { '0.2.2-rc.1': { compatible: true }, '0.2.3-rc.1': { compatible: true } },
      summary: { compatible: 2, incompatible: 0, errors: 0 },
    }],
  })
  assert.match(html, /0\.2\.3-rc\.1<span class="role">preview<\/span>/u)
})

test('a matrix with no roles still renders, without inventing them', () => {
  // Plain `--versions 0.2.1-rc.5` matrices have no selection, and the page must not claim a role for them.
  const html = renderCompatPage({
    schemaVersion: 1,
    generatedAt: '2026-11-08T11:30:00.000Z',
    hosts: ['0.2.1-rc.5'],
    plugins: [{
      name: 'p', version: '1.0.0',
      results: { '0.2.1-rc.5': { compatible: true } },
      summary: { compatible: 1, incompatible: 0, errors: 0 },
    }],
  })
  assert.doesNotMatch(html, /<span class="role">/u)
  // With no roles the first host is used, so the headline still names a real version.
  assert.match(html, /0\.2\.1-rc\.5/u)
})

test('tags that were left out are named, so the columns are explainable', () => {
  const html = renderCompatPage(matrix({
    hostRoles: ROLES,
    hostsDropped: [
      { spec: 'next', version: '0.2.2-rc.1', reason: 'points at the same version as latest (0.2.2-rc.1)' },
      { spec: 'alpha', version: '0.2.2-alpha.3', reason: 'older than latest (0.2.2-rc.1)' },
    ],
  }))

  assert.match(html, /Older prerelease tags are left out/u)
  assert.match(html, /alpha \(0\.2\.2-alpha\.3\)/u)
  // The list travels in an attribute as well, so the language toggle can rebuild it rather than dropping it.
  assert.match(html, /data-i18n="ignoredTags" data-list="next \(0\.2\.2-rc\.1\), alpha \(0\.2\.2-alpha\.3\)"/u)
})

test('with nothing dropped, the note is absent rather than empty', () => {
  const html = renderCompatPage(matrix({ hostRoles: ROLES, hostsDropped: [] }))
  assert.doesNotMatch(html, /data-i18n="ignoredTags"/u)
})
