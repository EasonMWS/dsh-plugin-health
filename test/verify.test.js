import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cacheKey, footprintDelta, levelOf, parseShard, predictConflicts, runVerify, shardOf, slugOf,
} from '../src/runtime/verify.js'
import { cmdVerify, main, parseArgv } from '../src/cli.js'

const HOST = '0.2.2-rc.1'

function hostDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-verify-'))
  const host = join(directory, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: HOST, bin: { dsh: 'lib/bin.js' } }))
  return { directory, host }
}

const BASE = { entries: [{ id: 'base', name: '@deepseek-ai/dsh-base', state: 2, disabled: false }], tools: ['bash', 'read'], toolsUnavailable: false }
const manifest = (name, version, engines) => ({ name, version, ...(engines ? { engines: { dsh: engines } } : {}), dist: { integrity: `sha512-${name}` } })

/** A fake registry and a fake smoke run, driven by a table of outcomes per plugin. */
function harness(outcomes) {
  const calls = { smoke: [], baseline: 0 }
  return {
    calls,
    deps: {
      baseline: async () => { calls.baseline += 1; return { hostVersion: HOST, footprint: BASE } },
      resolvePlugin: async (spec) => {
        const outcome = outcomes[spec]
        if (!outcome) throw new Error(`${spec}@x is not published`)
        return { name: spec, version: '1.0.0', manifest: manifest(spec, '1.0.0', outcome.engines) }
      },
      smoke: async (options) => {
        calls.smoke.push(options)
        const outcome = outcomes[options.pluginName]
        const stages = []
        if (options.bypassGate) stages.push({ name: 'allow-version', ok: true })
        stages.push({ name: 'install', ok: outcome.install !== false })
        if (outcome.install !== false) {
          stages.push({ name: 'runtime', ok: outcome.boot === true, details: { footprint: { entries: [...BASE.entries, ...(outcome.entries ?? [])], tools: [...BASE.tools, ...(outcome.tools ?? [])], toolsUnavailable: false } } })
        }
        const ok = outcome.install !== false && outcome.boot === true
        return { ok, stages, ...(ok ? {} : { failure: { stage: stages.at(-1).name, kind: outcome.kind ?? 'unknown', detail: '' } }) }
      },
      now: () => new Date('2026-11-09T00:00:00Z'),
    },
  }
}

test('levels: V1 declared, V2 installed, V3 activated; a rejected declaration has no level even if it boots', async () => {
  const { directory, host } = hostDirectory()
  const { deps, calls } = harness({
    good: { engines: '>=0.2.0-0 <0.3.0-0', boot: true, tools: ['good_tool'], entries: [{ id: 'good', name: 'good' }] },
    stuck: { engines: '>=0.2.0-0 <0.3.0-0', boot: false, kind: 'missing-service' },
    broken: { engines: '>=0.2.0-0 <0.3.0-0', install: false, kind: 'peer-conflict' },
    stale: { engines: '0.2.1-rc.5', boot: true },
  })
  const out = join(directory, 'out')
  const document = await runVerify({ dshDirectory: host, plugins: ['stale', 'good', 'broken', 'stuck', 'ghost'], out }, deps)
  const byName = Object.fromEntries(document.plugins.map((row) => [row.name, row]))
  assert.equal(byName.good.level, 'V3')
  assert.equal(byName.stuck.level, 'V2')
  assert.equal(byName.stuck.failure.kind, 'missing-service')
  assert.equal(byName.broken.level, 'V1')
  assert.equal(byName.stale.level, null, 'booting under an exemption does not raise the level')
  assert.equal(byName.stale.bypassed, true)
  assert.equal(byName.stale.bypass.level, 'V3', 'but the bypass run is recorded: it would have worked')
  assert.equal(byName.stale.failure.kind, 'gate-rejected')
  assert.equal(byName.ghost.failure.kind, 'not-found')
  assert.deepEqual(document.counts, { V1: 1, V2: 1, V3: 1, none: 2, failures: { 'missing-service': 1, 'peer-conflict': 1, 'gate-rejected': 1, 'not-found': 1 } })
  assert.equal(calls.smoke.find((options) => options.pluginName === 'stale').bypassGate, true)
  assert.ok(calls.smoke.every((options) => options.cleanEnv === true && options.bootOnly === true), 'verify always cleans the environment')
  assert.deepEqual(byName.good.footprint, { entries: 1, tools: ['good_tool'] }, 'only what the host did not already have')
  assert.ok(existsSync(join(out, 'results', 'good.json')))
  const saved = JSON.parse(readFileSync(join(out, 'verify.json'), 'utf8'))
  assert.equal(saved.host.version, HOST)
  assert.ok(Array.isArray(saved.conflicts))
})

test('a second run with the same cache reuses every result and the baseline', async () => {
  const { directory, host } = hostDirectory()
  const outcomes = { a: { engines: '>=0.2.0-0 <0.3.0-0', boot: true }, b: { engines: '>=0.2.0-0 <0.3.0-0', boot: false, kind: 'not-activated' } }
  const cache = join(directory, 'cache')
  const first = harness(outcomes)
  await runVerify({ dshDirectory: host, plugins: ['a', 'b'], out: join(directory, 'one'), cache }, first.deps)
  assert.equal(first.calls.smoke.length, 2)
  const second = harness(outcomes)
  const document = await runVerify({ dshDirectory: host, plugins: ['a', 'b'], out: join(directory, 'two'), cache }, second.deps)
  assert.equal(second.calls.smoke.length, 0, 'every plugin came from the cache')
  assert.equal(second.calls.baseline, 0, 'so did the baseline')
  assert.ok(document.plugins.every((row) => row.cached === true))
  assert.ok(existsSync(join(directory, 'two', 'results', 'b.json')), 'cached results are still written out')
})

test('the cache key changes with the bytes, the host and the tool line, but not with a patch release', () => {
  const base = { name: 'p', version: '1.0.0', integrity: 'sha512-x', host: HOST, toolVersion: '3.1.0' }
  assert.equal(cacheKey(base), cacheKey({ ...base, toolVersion: '3.1.7' }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, toolVersion: '3.2.0' }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, integrity: 'sha512-y' }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, host: '0.2.2-rc.2' }))
})

test('shards are stable, cover every plugin exactly once, and do not move when the list grows', () => {
  const names = Array.from({ length: 200 }, (_, index) => `plugin-${index}`)
  const before = Object.fromEntries(names.map((name) => [name, shardOf(name, 10)]))
  const after = Object.fromEntries([...names, 'a-new-one'].map((name) => [name, shardOf(name, 10)]))
  for (const name of names) assert.equal(after[name], before[name])
  assert.ok(Object.values(before).every((index) => index >= 1 && index <= 10))
  assert.ok(new Set(Object.values(before)).size > 5, 'not everything lands in one shard')
  assert.deepEqual(parseShard('3/10'), { index: 3, count: 10 })
  assert.throws(() => parseShard('0/10'), /1 <= i <= n/u)
  assert.throws(() => parseShard('three'), /3\/10/u)
})

test('a sharded run only runs its own shard', async () => {
  const { directory, host } = hostDirectory()
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const outcomes = Object.fromEntries(names.map((name) => [name, { engines: '>=0.2.0-0 <0.3.0-0', boot: true }]))
  const seen = []
  for (let index = 1; index <= 3; index += 1) {
    const { deps } = harness(outcomes)
    const document = await runVerify({ dshDirectory: host, plugins: names, out: join(directory, `s${index}`), shard: { index, count: 3 } }, deps)
    seen.push(...document.plugins.map((row) => row.name))
  }
  assert.deepEqual(seen.sort(), names)
})

test('slugs follow the scope rule and keep only safe characters', () => {
  assert.equal(slugOf('@Scope/Name'), 'scope__name')
  assert.equal(slugOf('plain-name.v2'), 'plain-name.v2')
  assert.equal(slugOf('weird name!'), 'weird-name-')
})

test('levelOf and footprintDelta', () => {
  assert.equal(levelOf({ ok: true }, true), 'V3')
  assert.equal(levelOf({ ok: false, stages: [{ name: 'install', ok: true }] }, true), 'V2')
  assert.equal(levelOf({ ok: false, stages: [{ name: 'install', ok: false }] }, true), 'V1')
  assert.equal(levelOf({ ok: true }, false), null)
  assert.equal(footprintDelta(null, BASE), null)
  assert.deepEqual(footprintDelta({ entries: [...BASE.entries, { id: 'x', name: 'x' }], tools: ['bash', 'x_tool'] }, BASE).tools, ['x_tool'])
  assert.equal(footprintDelta({ entries: [], tools: ['bash'] }, null).baseline, 'none')
})

test('conflict prediction: none, two-way and three-way, always marked predicted', () => {
  const row = (name, tools, ids = []) => ({ name, version: '1.0.0', footprint: { tools, entries: ids.map((id) => ({ id })) } })
  assert.deepEqual(predictConflicts([row('a', ['a_tool']), row('b', ['b_tool'])]), [])
  assert.deepEqual(predictConflicts([row('a', ['web_search']), row('b', ['web_search'])]), [
    { kind: 'tool-name', name: 'web_search', plugins: ['a@1.0.0', 'b@1.0.0'], predicted: true },
  ])
  const three = predictConflicts([row('a', ['web_search'], ['dup']), row('b', ['web_search'], ['dup']), row('c', ['web_search']), { name: 'd', version: '1', footprint: null }])
  assert.deepEqual(three.map((conflict) => [conflict.kind, conflict.plugins.length]), [['tool-name', 3], ['entry-id', 2]])
  assert.ok(three.every((conflict) => conflict.predicted === true))
})

test('verify exit codes: 0 when done, 1 with --fail-on any short of V3, 2 for usage errors', async () => {
  const fake = (levels) => async () => ({ host: { version: HOST }, counts: { V1: 0, V2: 0, V3: 0, none: 0, failures: {} }, conflicts: [], plugins: levels.map((level, index) => ({ name: `p${index}`, level })) })
  const options = (extra = []) => parseArgv(['verify', '--dsh-dir', 'd', '--plugins', 'a,b', '--out', 'o', ...extra]).options
  const quiet = console.log
  console.log = () => {}
  try {
    assert.equal(await cmdVerify(options(), { verify: fake(['V3', 'V1']) }), 0)
    assert.equal(await cmdVerify(options(['--fail-on', 'any']), { verify: fake(['V3', 'V1']) }), 1)
    assert.equal(await cmdVerify(options(['--fail-on', 'any']), { verify: fake(['V3', 'V3']) }), 0)
  } finally {
    console.log = quiet
  }
  const error = console.error
  console.error = () => {}
  try {
    assert.equal(await main(['verify', '--plugins', 'a']), 2)
    assert.equal(await main(['verify', '--dsh-dir', 'd', '--plugins', 'a', '--out', 'o', '--fail-on', 'host']), 2)
    assert.equal(await main(['verify', '--dsh-dir', 'd', '--plugins', 'a', '--out', 'o', '--shard', '11/10']), 2)
  } finally {
    console.error = error
  }
})

test('trials and the baseline get the web app by default, and the profile is recorded', async () => {
  const { directory, host } = hostDirectory()
  const { deps, calls } = harness({ a: { engines: '>=0.2.0-0 <0.3.0-0', boot: true } })
  let baselineOptions
  const document = await runVerify({ dshDirectory: host, plugins: ['a'], out: join(directory, 'o') }, {
    ...deps,
    baseline: async (options) => { baselineOptions = options; return { hostVersion: HOST, footprint: BASE } },
  })
  assert.deepEqual(calls.smoke[0].hostBundles, ['@deepseek-ai/dsh-web-app'])
  assert.deepEqual(baselineOptions.hostBundles, ['@deepseek-ai/dsh-web-app'], 'the baseline has the same composition')
  assert.deepEqual(document.profile.hostBundles, ['@deepseek-ai/dsh-web-app'])
})

test('a bare run does not reuse results from a web-profile run', async () => {
  const { directory, host } = hostDirectory()
  const cache = join(directory, 'cache')
  const outcomes = { a: { engines: '>=0.2.0-0 <0.3.0-0', boot: true } }
  await runVerify({ dshDirectory: host, plugins: ['a'], out: join(directory, 'web'), cache }, harness(outcomes).deps)
  const bare = harness(outcomes)
  await runVerify({ dshDirectory: host, plugins: ['a'], out: join(directory, 'bare'), cache, hostBundles: [] }, bare.deps)
  assert.equal(bare.calls.smoke.length, 1, 'different profile, different result')
})

test('addHostBundles adds only official bundles the host carries, without duplicates', async () => {
  const { addHostBundles } = await import('../src/runtime/smoke.js')
  const { directory, host } = hostDirectory()
  mkdirSync(join(host, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
  writeFileSync(join(host, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: HOST }))
  const profile = join(directory, 'profile')
  mkdirSync(profile)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plugin-x'] } } }))
  assert.deepEqual(addHostBundles(profile, host, ['@deepseek-ai/dsh-web-app']), ['@deepseek-ai/dsh-web-app'])
  assert.deepEqual(addHostBundles(profile, host, ['@deepseek-ai/dsh-web-app']), [], 'idempotent')
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', 'plugin-x', '@deepseek-ai/dsh-web-app'])
  assert.throws(() => addHostBundles(profile, host, ['some-third-party']), /official/u)
  assert.throws(() => addHostBundles(profile, host, ['@deepseek-ai/dsh-not-shipped']), /does not carry/u)
})
