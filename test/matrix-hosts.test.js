import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveHostSelection, resolveHostVersions, selectCurrentHosts } from '../src/compat/matrix.js'

// The page used to ask for `latest,next,alpha` by name. On 2026-11-08 that produced two columns: the real
// latest, `0.2.2-rc.1`, and `alpha`, which pointed at `0.2.2-alpha.3` — five days older. 135 plugins were
// reported as rejected because of a host nobody runs. These tests pin the selection rule that replaced it.

/** The registry document on 2026-11-08, trimmed to the parts that decide the selection. */
const PACKUMENT = {
  'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.1', alpha: '0.2.2-alpha.3' },
  versions: {
    '0.2.0-rc.2': {},
    '0.2.1-rc.4': {},
    '0.2.1-rc.5': {},
    '0.2.2-alpha.3': {},
    '0.2.2-rc.1': {},
  },
}

test('the selection is the latest release and the previous line, not a stale prerelease tag', () => {
  const selection = selectCurrentHosts(PACKUMENT)

  assert.deepEqual(selection.hosts, ['0.2.2-rc.1', '0.2.1-rc.5'],
    'latest first, then the newest version on the previous minor line')
  assert.equal(selection.roles['0.2.2-rc.1'], 'latest')
  assert.equal(selection.roles['0.2.1-rc.5'], 'previous')

  const droppedTags = selection.dropped.map((row) => row.spec)
  assert.ok(droppedTags.includes('alpha'), 'alpha must be reported as left out')
  assert.ok(droppedTags.includes('next'), 'next pointed at latest, so it adds nothing and must be reported')

  const alpha = selection.dropped.find((row) => row.spec === 'alpha')
  assert.equal(alpha.version, '0.2.2-alpha.3')
  assert.match(alpha.reason, /older than latest/u)
})

test('a dist-tag ahead of latest becomes a preview column', () => {
  // This is the case the old behaviour got right by accident and the new one has to keep getting right:
  // when `next` really is newer, it is worth showing.
  const selection = selectCurrentHosts({
    'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.3-rc.1', alpha: '0.2.2-alpha.3' },
    versions: { '0.2.1-rc.5': {}, '0.2.2-rc.1': {}, '0.2.3-rc.1': {} },
  })

  assert.deepEqual(selection.hosts, ['0.2.2-rc.1', '0.2.3-rc.1', '0.2.1-rc.5'])
  assert.equal(selection.roles['0.2.3-rc.1'], 'next')
  assert.equal(selection.dropped.some((row) => row.spec === 'next'), false, 'next was ahead, so it stays')
})

test('a registry with no usable latest version is an error, not an empty table', () => {
  assert.throws(() => selectCurrentHosts({}), /valid latest/u)
  assert.throws(() => selectCurrentHosts({ 'dist-tags': { latest: 'not-a-version' } }), /valid latest/u)
})

test('the previous line is skipped when there is nothing below latest', () => {
  const selection = selectCurrentHosts({
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {}, '1.1.0-beta.1': {} },
  })
  assert.deepEqual(selection.hosts, ['1.0.0'])
  assert.equal(selection.roles['1.0.0'], 'latest')
})

test('a prerelease on the previous line still counts as the previous line', () => {
  // 0.2.1-rc.5 is the newest release of the 0.2.1 line even though it never shipped as a stable version.
  const selection = selectCurrentHosts({
    'dist-tags': { latest: '0.2.2' },
    versions: { '0.2.0': {}, '0.2.1-rc.4': {}, '0.2.1-rc.5': {}, '0.2.2': {} },
  })
  assert.deepEqual(selection.hosts, ['0.2.2', '0.2.1-rc.5'])
})

// ---------- resolveHostVersions keeps its old contract ----------

/** A packument loader that never touches the network. */
const loadPackument = async () => PACKUMENT

test('`current` expands to the selection', async () => {
  const hosts = await resolveHostVersions(['current'], { loadPackument })
  assert.deepEqual(hosts, ['0.2.2-rc.1', '0.2.1-rc.5'])
})

test('existing specs keep their old meaning', async () => {
  // The 3.x promise is that existing arguments do not change meaning, so `latest,next` must still expand
  // exactly as it did — no roles, no previous line, no dropping.
  const hosts = await resolveHostVersions(['latest', 'next'], { loadPackument })
  assert.deepEqual(hosts, ['0.2.2-rc.1'], 'both tags resolve to the same version, deduplicated as before')

  const exact = await resolveHostVersions(['0.2.1-rc.4'], { loadPackument })
  assert.deepEqual(exact, ['0.2.1-rc.4'])
})

test('an unknown dist-tag or version is still an error', async () => {
  await assert.rejects(resolveHostVersions(['nope'], { loadPackument }), /unknown DSH host version/u)
})

test('the selection reports its roles, and plain specs report none', async () => {
  const selection = await resolveHostSelection(['current'], { loadPackument })
  assert.deepEqual(selection.hosts, ['0.2.2-rc.1', '0.2.1-rc.5'])
  assert.equal(selection.roles['0.2.2-rc.1'], 'latest')
  assert.ok(Array.isArray(selection.dropped))

  const plain = await resolveHostSelection(['0.2.2-rc.1'], { loadPackument })
  assert.equal(plain.roles, undefined, 'a caller who named versions by hand gets no roles to render')
  assert.equal(plain.dropped, undefined)
})