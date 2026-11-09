import test from 'node:test'
import assert from 'node:assert/strict'
import { forecastRow, nextBuildsOf } from '../src/compat/forecast.js'
import { diffSnapshots, snapshotOf, summarizeHistory } from '../src/compat/history.js'

const HOST = '0.2.2-rc.1'
const row = (declared, declaredRanges, compatible = true) => ({ declared, declaredRanges, results: { [HOST]: { compatible } } })

test('next builds are the next prerelease and the release it is heading for', () => {
  assert.deepEqual(nextBuildsOf('0.2.2-rc.1'), ['0.2.2-rc.2', '0.2.2'])
  assert.deepEqual(nextBuildsOf('0.2.2'), ['0.2.3'])
  assert.deepEqual(nextBuildsOf('nonsense'), [])
})

test('an enumeration that names the current build is at risk on the next one', () => {
  const enumerated = forecastRow(row('engines', { 'engines.dsh': '0.2.1-rc.5 || 0.2.2-rc.1' }), HOST)
  assert.equal(enumerated.atRisk, true)
  assert.deepEqual(enumerated.rejects, ['0.2.2-rc.2', '0.2.2'])
  assert.equal(forecastRow(row('engines', { 'engines.dsh': '>=0.2.0-0 <0.3.0-0' }), HOST).atRisk, false)
  // ^0.2.2-rc.1 admits 0.2.2-rc.2 and 0.2.2.
  assert.equal(forecastRow(row('peers', { '@deepseek-ai/dsh-tools': '^0.2.2-rc.1' }), HOST).atRisk, false)
  assert.equal(forecastRow(row('peers', { '@deepseek-ai/dsh-tools': '0.2.2-rc.1', '@deepseek-ai/dsh': '>=0.2.0-0' }), HOST).atRisk, true)
})

test('only rows accepted today and with a declaration are forecast', () => {
  assert.equal(forecastRow(row('engines', { 'engines.dsh': '0.2.1-rc.5' }, false), HOST), null, 'already rejected is a finding, not a forecast')
  assert.equal(forecastRow(row('none', {}), HOST), null, 'the gate never checks an undeclared plugin')
})

const matrix = (rows, latest = HOST, hosts = [latest]) => ({
  hosts, hostRoles: { [latest]: 'latest' },
  plugins: rows.map(([name, version, compatible]) => ({ name, version, results: { [latest]: { compatible } } })),
})

test('snapshots diff into fixed / broken events on the latest host, with the cause', () => {
  const day1 = snapshotOf(matrix([['a', '1.0.0', false], ['b', '1.0.0', true], ['c', '1.0.0', true]]), '2026-11-01')
  const day2 = snapshotOf(matrix([['a', '1.0.1', true], ['b', '1.0.1', false], ['c', '1.0.0', true], ['d', '1.0.0', false]]), '2026-11-02')
  const events = diffSnapshots(day1, day2)
  assert.deepEqual(events.map((event) => [event.name, event.kind]), [['a', 'fixed'], ['b', 'broken-by-release'], ['d', 'added']])
  assert.equal(events[0].from, '1.0.0')
  assert.equal(events[0].to, '1.0.1')
})

test('a host release that rejects an unchanged plugin is recorded as broken-by-host', () => {
  const before = snapshotOf(matrix([['e', '1.0.0', true]], '0.2.1-rc.5'), '2026-11-02')
  const after = snapshotOf(matrix([['e', '1.0.0', false]], '0.2.2-rc.1'), '2026-11-03')
  assert.deepEqual(diffSnapshots(before, after).map((event) => event.kind), ['broken-by-host'])
})

test('no previous snapshot means no events, and an unchanged day means none either', () => {
  const day = snapshotOf(matrix([['a', '1.0.0', true]]), '2026-11-01')
  assert.deepEqual(diffSnapshots(null, day), [])
  assert.deepEqual(diffSnapshots(day, { ...day, date: '2026-11-02' }), [])
})

test('the summary keeps when the current state began and the last fix', () => {
  const summary = summarizeHistory([
    { date: '2026-10-20', name: 'a', kind: 'added', state: 'ok' },
    { date: '2026-11-03', name: 'a', kind: 'broken-by-host' },
    { date: '2026-11-05', name: 'a', kind: 'fixed' },
    { date: '2026-11-03', name: 'b', kind: 'broken-by-host' },
  ])
  assert.deepEqual(summary.get('a'), { events: 3, since: '2026-11-05', state: 'ok', lastFixed: '2026-11-05' })
  assert.deepEqual(summary.get('b'), { events: 1, since: '2026-11-03', state: 'bad' })
})
