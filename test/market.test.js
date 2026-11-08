import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bestVersionFor, judgeMarket, loadMarket } from '../src/outside/market.js'

// The market module answers "of the things in this market, which would the host you are running actually
// load?". A wrong answer here tells someone to install something that will be rejected, so the cases that
// matter are the ones where the declaration excludes the version.

/**
 * A format-1 index, built to match what the official parser requires.
 * @param {Array<object>} plugins
 */
function indexOf(plugins) {
  return {
    format: 1,
    title: 'Test market',
    plugins,
  }
}

/** One market entry. */
function entry(name, versions, extra = {}) {
  return {
    name,
    versions: versions.map((row) => ({
      version: row.version,
      publishTimestamp: 1_760_000_000,
      source: { type: 'npm' },
      engines: row.dsh === undefined ? {} : { dsh: row.dsh },
    })),
    ...extra,
  }
}

function tempFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'market-'))
  const path = join(dir, 'index.json')
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return { dir, path }
}

test('a valid format-1 index loads through the official parser', async () => {
  const { dir, path } = tempFile(indexOf([entry('dsh-a', [{ version: '1.0.0', dsh: '^0.2.0' }])]))
  try {
    const result = await loadMarket(path)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.market.plugins.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an index that is not format 1 is refused with the parser\'s own diagnostic', async () => {
  // Reusing DSH's parser means the message names the JSON path, which is the most useful thing to show.
  const { dir, path } = tempFile({ format: 2, title: 'x', plugins: [] })
  try {
    const result = await loadMarket(path)
    assert.equal(result.ok, false)
    assert.match(result.error, /format 1/u)
    assert.match(result.error, /\$\.format/u, 'the message should name the offending path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file that is not JSON is refused', async () => {
  const { dir, path } = tempFile('{ not json')
  try {
    const result = await loadMarket(path)
    assert.equal(result.ok, false)
    assert.match(result.error, /not JSON/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file is refused', async () => {
  const result = await loadMarket(join(tmpdir(), 'definitely-not-here', 'index.json'))
  assert.equal(result.ok, false)
  assert.match(result.error, /no such file/u)
})

test('an empty source is refused', async () => {
  const result = await loadMarket('   ')
  assert.equal(result.ok, false)
  assert.match(result.error, /source is required/u)
})

test('an http source that fails is reported, not thrown', async () => {
  const result = await loadMarket('https://example.test/index.json', {
    fetch: async () => ({ ok: false, status: 503, headers: { get: () => null } }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /503/u)
})

test('an http source that hangs is abandoned with a reason', async () => {
  // A market that never answers must not hang the manager.
  const result = await loadMarket('https://example.test/index.json', {
    timeoutMs: 50,
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /did not answer/u)
})

test('the newest version that admits the target is the one chosen', () => {
  // A market entry lists versions newest first. The best pick is the newest that will actually load, not
  // simply the newest.
  const versions = [
    { version: '3.0.0', engines: { dsh: '>=0.3.0' }, source: { type: 'npm' } },
    { version: '2.0.0', engines: { dsh: '^0.2.0' }, source: { type: 'npm' } },
    { version: '1.0.0', engines: { dsh: '^0.1.0' }, source: { type: 'npm' } },
  ]

  const best = bestVersionFor(versions, '0.2.2-rc.1')
  assert.equal(best.state, 'compatible')
  assert.equal(best.version.version, '2.0.0', 'the newest compatible version, not the newest overall')
})

test('a plugin with no version admitting the target is incompatible, and says why', () => {
  const versions = [{ version: '1.0.0', engines: { dsh: '0.1.7' }, source: { type: 'npm' } }]
  const best = bestVersionFor(versions, '0.2.2-rc.1')
  assert.equal(best.state, 'incompatible')
  assert.match(best.reason, /0\.1\.7/u)
})

test('a version that declares no engines.dsh does not admit anything', () => {
  // A missing engines field is not a wildcard: the host will reject it, so the market view must agree.
  const versions = [{ version: '1.0.0', engines: {}, source: { type: 'npm' } }]
  const best = bestVersionFor(versions, '0.2.2-rc.1')
  assert.equal(best.state, 'incompatible')
  assert.match(best.reason, /no engines\.dsh/u)
})

test('without a target version the verdict is unknown, not compatible', () => {
  // Guessing here would tell someone a plugin is fine when nothing was checked.
  const versions = [{ version: '1.0.0', engines: { dsh: '^0.2.0' }, source: { type: 'npm' } }]
  assert.equal(bestVersionFor(versions, undefined).state, 'unknown')
  assert.equal(bestVersionFor(versions, '').state, 'unknown')
  assert.equal(bestVersionFor([], '0.2.2').state, 'unknown')
})

test('judging a market puts the rejected entries first and counts them', () => {
  const market = {
    title: 'Test market',
    plugins: [
      { ...entry('dsh-fine', [{ version: '1.0.0', dsh: '^0.2.0' }]), title: 'Fine' },
      { ...entry('dsh-broken', [{ version: '1.0.0', dsh: '0.1.7' }]), title: 'Broken' },
      { ...entry('dsh-nodesh', [{ version: '1.0.0' }]), title: 'No engines' },
    ],
  }

  const judged = judgeMarket({ market, runtimeVersion: '0.2.2-rc.1' })
  assert.equal(judged.counts.incompatible, 2)
  assert.equal(judged.counts.compatible, 1)
  assert.equal(judged.total, 3)
  assert.equal(judged.judgedAgainst, '0.2.2-rc.1')

  // The ones the host would reject come first, because those are what the user needs to see.
  assert.equal(judged.plugins[0].verdict, 'incompatible')
  assert.equal(judged.plugins[judged.plugins.length - 1].verdict, 'compatible')
})

test('a market row names the exact version and install spec that would work', () => {
  const market = {
    title: 'M',
    plugins: [{
      ...entry('dsh-a', [
        { version: '2.0.0', dsh: '>=0.3.0' },
        { version: '1.5.0', dsh: '^0.2.0' },
      ]),
      title: 'A plugin',
    }],
  }

  const judged = judgeMarket({ market, runtimeVersion: '0.2.2-rc.1' })
  const row = judged.plugins[0]
  assert.equal(row.usableVersion, '1.5.0')
  assert.equal(row.latestVersion, '2.0.0')
  // Reported as text, never offered as an action: installing is DSH's decision.
  assert.equal(row.installSpec, 'dsh-a@1.5.0')
})

test('the market view reports what is already installed', () => {
  const market = { title: 'M', plugins: [entry('dsh-a', [{ version: '1.0.0', dsh: '^0.2.0' }])] }
  const judged = judgeMarket({
    market,
    runtimeVersion: '0.2.2-rc.1',
    installed: [{ name: 'dsh-a', version: '0.9.0' }],
  })
  const row = judged.plugins[0]
  assert.equal(row.installed, true)
  assert.equal(row.installedVersion, '0.9.0')
  assert.equal(judged.installedCount, 1)
})

test('a target version overrides the running one', () => {
  // "Will this work after I upgrade?" is the question worth asking before an upgrade.
  const market = { title: 'M', plugins: [entry('dsh-a', [{ version: '1.0.0', dsh: '^0.2.0' }])] }
  assert.equal(judgeMarket({ market, runtimeVersion: '0.2.2', targetVersion: '0.2.2' }).counts.compatible, 1)
  assert.equal(judgeMarket({ market, runtimeVersion: '0.2.2', targetVersion: '0.3.0' }).counts.incompatible, 1)
})

test('a localized title is shown in English, and falls back to the name', () => {
  const market = {
    title: { en: 'Market', 'zh-cn': '市场' },
    plugins: [
      { ...entry('dsh-titled', [{ version: '1.0.0', dsh: '^0.2.0' }]), title: { en: 'Titled', 'zh-cn': '中文' } },
      entry('dsh-untitled', [{ version: '1.0.0', dsh: '^0.2.0' }]),
    ],
  }
  const judged = judgeMarket({ market, runtimeVersion: '0.2.2' })
  assert.equal(judged.title, 'Market')
  assert.equal(judged.plugins.find((row) => row.name === 'dsh-titled').title, 'Titled')
  assert.equal(judged.plugins.find((row) => row.name === 'dsh-untitled').title, 'dsh-untitled')
})

test('the report says what it did not do', () => {
  // A market view that does not state its limits invites being read as "these are safe to install".
  const judged = judgeMarket({ market: { title: 'M', plugins: [] }, runtimeVersion: '0.2.2' })
  assert.ok(Array.isArray(judged.limits) && judged.limits.length > 0)
  assert.ok(judged.limits.includes('no-install-performed'))
  assert.ok(judged.limits.includes('declarations-only'))
})