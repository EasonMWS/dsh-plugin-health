import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  auditRescues, declarationConflict, grantExemption, readExemptions,
  readRescueState, rescuePlugin, revokeExemption, undoRescue, writeRescueState,
} from '../src/rescue/rescue.js'
import { classifyUpstream, selectUpstreamTarget } from '../src/rescue/upstream.js'
import { buildReport, repositorySlug, searchQuery, suggestRange } from '../src/rescue/reporting.js'
import semver from 'semver'
import { buildBrief, groupRanges, renderPrompt, writeHandoff, readHandoff } from '../src/rescue/handoff.js'

function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-health-rescue-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  return dir
}

test('readExemptions tolerates a missing, empty and malformed file', () => {
  const dir = profile()
  assert.deepEqual(readExemptions(dir), {})
  writeFileSync(join(dir, 'compatibility.json'), '{"a@1":["0.2.1-rc.4"]}')
  assert.deepEqual(readExemptions(dir), { 'a@1': ['0.2.1-rc.4'] })
  writeFileSync(join(dir, 'compatibility.json'), 'not json')
  assert.deepEqual(readExemptions(dir), {}, 'a corrupt host file must not break a scan')
  writeFileSync(join(dir, 'compatibility.json'), '[1,2]')
  assert.deepEqual(readExemptions(dir), {}, 'a non-object must not be trusted')
})

test('grantExemption appends without dropping the versions already listed', () => {
  const dir = profile()
  writeFileSync(join(dir, 'compatibility.json'), '{"p@1":["0.2.1-rc.3"]}')
  const result = grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4' })
  assert.equal(result.previous[0], '0.2.1-rc.3')
  assert.deepEqual(readExemptions(dir)['p@1'], ['0.2.1-rc.3', '0.2.1-rc.4'])
})

test('grantExemption is idempotent for the same version', () => {
  const dir = profile()
  grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4' })
  grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4' })
  assert.deepEqual(readExemptions(dir)['p@1'], ['0.2.1-rc.4'])
})

test('revokeExemption removes the key this tool created', () => {
  const dir = profile()
  const grant = grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4' })
  revokeExemption(dir, { key: grant.key, previous: grant.previous, runtimeVersion: '0.2.1-rc.4' })
  assert.deepEqual(readExemptions(dir), {}, 'a key we created should not linger when emptied')
})

test('revokeExemption restores the pre-existing list instead of deleting the key', () => {
  const dir = profile()
  writeFileSync(join(dir, 'compatibility.json'), '{"p@1":["0.2.1-rc.3"]}')
  const grant = grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4' })
  revokeExemption(dir, { key: grant.key, previous: grant.previous, runtimeVersion: '0.2.1-rc.4' })
  assert.deepEqual(readExemptions(dir)['p@1'], ['0.2.1-rc.3'], 'the user\'s own exemption must survive an undo')
})

test('undoRescue revokes everything and empties the ledger', () => {
  const dir = profile()
  const grant = grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4' })
  writeRescueState(dir, { version: 1, entries: [{ key: grant.key, name: 'p', version: '1', runtimeVersion: '0.2.1-rc.4', previous: grant.previous }] })
  const { undone, remaining } = undoRescue(dir)
  assert.equal(undone.length, 1)
  assert.equal(remaining.length, 0)
  assert.deepEqual(readExemptions(dir), {})
  assert.deepEqual(readRescueState(dir).entries, [])
})

test('undoRescue can target a single key', () => {
  const dir = profile()
  const a = grantExemption(dir, { name: 'a', version: '1', runtimeVersion: '0.2.1-rc.4' })
  const b = grantExemption(dir, { name: 'b', version: '2', runtimeVersion: '0.2.1-rc.4' })
  writeRescueState(dir, {
    version: 1,
    entries: [
      { key: a.key, name: 'a', version: '1', runtimeVersion: '0.2.1-rc.4', previous: a.previous },
      { key: b.key, name: 'b', version: '2', runtimeVersion: '0.2.1-rc.4', previous: b.previous },
    ],
  })
  const { undone, remaining } = undoRescue(dir, { key: a.key })
  assert.equal(undone.length, 1)
  assert.equal(remaining.length, 1)
  assert.equal(readExemptions(dir)['b@2'] !== undefined, true, 'the other rescue must stay applied')
})

test('auditRescues flags a rescue as stale once a newer version is installed', () => {
  const dir = profile()
  const grant = grantExemption(dir, { name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4' })
  writeRescueState(dir, {
    version: 1,
    entries: [{ key: grant.key, name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4', previous: grant.previous }],
  })
  const fresh = auditRescues(dir, { readManifest: () => ({ version: '1.0.0' }), runtimeVersion: '0.2.1-rc.4' })
  assert.equal(fresh[0].stale, false)
  const upgraded = auditRescues(dir, { readManifest: () => ({ version: '1.1.0' }), runtimeVersion: '0.2.1-rc.4' })
  assert.equal(upgraded[0].stale, true, 'a newer installed version is the signal that an upstream fix landed')
})

test('rescuePlugin refuses to grant anything when the rehearsal fails', async () => {
  const dir = profile()
  const result = await rescuePlugin({
    profileDir: dir,
    dshDirectory: '/nonexistent',
    plugin: 'p@1.0.0',
    runtimeVersion: '0.2.1-rc.4',
    profile: 'test',
    rehearseImpl: async () => ({ verdict: 'broken', report: { stages: [] } }),
  })
  assert.equal(result.applied, false)
  assert.equal(result.verdict, 'broken')
  assert.deepEqual(readExemptions(dir), {}, 'a failed rehearsal must never write an exemption')
})

test('rescuePlugin applies only after a passing rehearsal and records the previous value', async () => {
  const dir = profile()
  writeFileSync(join(dir, 'compatibility.json'), '{"p@1.0.0":["0.2.1-rc.3"]}')
  const result = await rescuePlugin({
    profileDir: dir,
    dshDirectory: '/nonexistent',
    plugin: 'p@1.0.0',
    runtimeVersion: '0.2.1-rc.4',
    profile: 'test',
    rehearseImpl: async () => ({ verdict: 'runs', report: { stages: [], directory: '/tmp/run' } }),
  })
  assert.equal(result.applied, true)
  assert.deepEqual(readExemptions(dir)['p@1.0.0'], ['0.2.1-rc.3', '0.2.1-rc.4'])
  assert.deepEqual(readRescueState(dir).entries[0].previous, ['0.2.1-rc.3'])
})

test('rescuePlugin in dry-run mode rehearses but writes nothing', async () => {
  const dir = profile()
  const result = await rescuePlugin({
    profileDir: dir,
    dshDirectory: '/nonexistent',
    plugin: 'p@1.0.0',
    runtimeVersion: '0.2.1-rc.4',
    profile: 'test',
    dryRun: true,
    rehearseImpl: async () => ({ verdict: 'runs', report: { stages: [] } }),
  })
  assert.equal(result.wouldApply, true)
  assert.deepEqual(readExemptions(dir), {})
  assert.deepEqual(readRescueState(dir).entries, [])
})

test('declarationConflict reports the unmet requirements for a rejected manifest', () => {
  const manifest = { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' } }
  const conflict = declarationConflict(manifest, '0.2.1-rc.4')
  assert.equal(conflict.blocked, true)
  assert.deepEqual(conflict.requirements, { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' })
})

test('declarationConflict accepts a manifest that already covers the host', () => {
  const manifest = { name: 'p', version: '1.0.0', engines: { dsh: '>=0.2.1-rc.2 <0.2.2-0' } }
  assert.equal(declarationConflict(manifest, '0.2.1-rc.4').blocked, false)
})

test('selectUpstreamTarget separates "newer" from "actually fixed"', () => {
  const packument = {
    'dist-tags': { latest: '1.2.0' },
    versions: {
      '1.0.0': { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' } },
      '1.2.0': { name: 'p', version: '1.2.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' } },
    },
  }
  const target = selectUpstreamTarget(packument, '0.2.1-rc.4')
  assert.equal(target.latest, '1.2.0')
  assert.equal(target.fixed, undefined, 'a newer version that still rejects the host is not a fix')
  assert.equal(classifyUpstream({ installedVersion: '1.0.0', runtimeVersion: '0.2.1-rc.4', target }), 'newer-but-still-incompatible')
})

test('selectUpstreamTarget finds the release that admits the host', () => {
  const packument = {
    'dist-tags': { latest: '1.3.0' },
    versions: {
      '1.0.0': { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' } },
      '1.3.0': { name: 'p', version: '1.3.0', peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.1-rc.2 <0.2.2-0' } },
    },
  }
  const target = selectUpstreamTarget(packument, '0.2.1-rc.4')
  assert.equal(target.fixed, '1.3.0')
  assert.equal(classifyUpstream({ installedVersion: '1.0.0', runtimeVersion: '0.2.1-rc.4', target }), 'fix-available')
})

test('classifyUpstream reports no release when nothing newer exists', () => {
  assert.equal(
    classifyUpstream({ installedVersion: '1.0.0', runtimeVersion: '0.2.1-rc.4', target: { latest: '1.0.0' } }),
    'no-upstream-release',
  )
})

test('repositorySlug handles the shapes a package.json actually uses', () => {
  assert.equal(repositorySlug({ repository: 'https://github.com/o/r' }), 'o/r')
  assert.equal(repositorySlug({ repository: { url: 'git+https://github.com/o/r.git' } }), 'o/r')
  assert.equal(repositorySlug({ repository: { url: 'git@github.com:o/r.git' } }), 'o/r')
  assert.equal(repositorySlug({ repository: 'github:o/r' }), 'o/r')
  assert.equal(repositorySlug({}), undefined)
})

test('searchQuery names the package and the host version so a duplicate is recognisable', () => {
  assert.equal(searchQuery({ name: 'p', runtimeVersion: '0.2.1-rc.4' }), 'p 0.2.1-rc.4 compatibility')
})

test('buildReport states the declaration mismatch and never invents code damage', () => {
  const report = buildReport({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' },
    rehearsal: 'runs', toolVersion: '0.6.0',
  })
  assert.match(report.title, /0\.2\.1-rc\.4/u)
  assert.match(report.body, /dsh-plugin-health-report/u, 'the marker lets a later scan recognise our own report')
  assert.match(report.body, /installs and boots/u)
  assert.doesNotMatch(report.body, /security|vulnerab/iu, 'reporting stays on compatibility')
})

test('buildReport distinguishes a broken plugin from a declaration-only mismatch', () => {
  const report = buildReport({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' }, rehearsal: 'broken',
  })
  assert.match(report.body, /still fails to boot/u)
})

test('renderPrompt branches on the rehearsal verdict instead of always asking for a fix', () => {
  const base = {
    plugin: { name: 'p', version: '1.0.0', declaredRequirements: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' }, repository: null },
    host: { runtimeVersion: '0.2.1-rc.4' },
    rehearsal: { verdict: 'runs', stages: [{ name: 'runtime', ok: true }] },
  }
  const booted = renderPrompt(base)
  assert.match(booted, /only the declared ranges are out of date/u)
  assert.match(booted, /Acceptance criteria/u, 'the acceptance test is part of the instruction')
  assert.match(booted, /installs and boots on the target host/u)

  const broken = renderPrompt({ ...base, rehearsal: { verdict: 'failed', stages: [{ name: 'runtime', ok: false, error: 'boom' }] } })
  assert.match(broken, /Work out why the plugin fails to boot/u)
  assert.match(broken, /boom/u)
})

test('renderPrompt forbids feature work and dishonest range widening', () => {
  const prompt = renderPrompt({
    plugin: { name: 'p', version: '1.0.0', declaredRequirements: {}, repository: null },
    host: { runtimeVersion: '0.2.1-rc.4' },
    rehearsal: { verdict: 'failed', stages: [] },
  })
  assert.match(prompt, /Do not add or remove features/u)
  assert.match(prompt, /rather than widening ranges to hide it/u)
})

test('handoff writes the brief, the prompt and the rehearsal evidence', () => {
  const dir = profile()
  const brief = buildBrief({
    name: '@scope/p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements: { a: '1' }, installedManifest: { engines: { dsh: '1' } },
    smokeReport: { ok: false, stages: [{ name: 'runtime', ok: false, details: { stage: 'boot' } }] },
    repositoryUrl: 'https://github.com/o/r', toolVersion: '0.6.0',
  })
  const written = writeHandoff(dir, brief, { ok: false, stages: [] })
  assert.equal(written.files.length, 3)
  const read = readHandoff(dir, '@scope/p', '1.0.0')
  assert.match(read.prompt, /restore DSH plugin compatibility/u)
  assert.deepEqual(read.brief.plugin.declaredRequirements, { a: '1' })
  assert.equal(JSON.parse(readFileSync(join(written.directory, 'rehearsal.json'), 'utf8')).ok, false)
})

// --- the brief must not claim a rehearsal it did not run -------------------------------

test('groupRanges collapses peers that share one range', () => {
  const grouped = groupRanges({
    '@deepseek-ai/dsh-llm': '0.2.1-rc.3 || 0.2.1-rc.2',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.3 || 0.2.1-rc.2',
    '@deepseek-ai/dsh-agent': '^1.0.0',
  })
  assert.equal(grouped.length, 2, 'two distinct ranges, not three packages')
  assert.equal(grouped[0].packages.length, 2, 'the widest group comes first')
  assert.equal(grouped[0].range, '0.2.1-rc.3 || 0.2.1-rc.2')
})

test('a brief without a rehearsal is marked not-run, never failed', () => {
  const brief = buildBrief({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements: { a: '1' }, installedManifest: {},
  })
  assert.equal(brief.rehearsal.verdict, 'not-run')
  const prompt = renderPrompt(brief)
  assert.match(prompt, /no isolated runtime test was run/u)
  assert.doesNotMatch(prompt, /fails to boot/u, 'an untested plugin must not be described as broken')
})

test('a brief with a failing rehearsal does say the plugin fails to boot', () => {
  const brief = buildBrief({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements: { a: '1' }, installedManifest: {},
    smokeReport: { ok: false, stages: [{ name: 'runtime', ok: false, error: 'boom' }] },
  })
  assert.equal(brief.rehearsal.verdict, 'failed')
  const prompt = renderPrompt(brief)
  assert.match(prompt, /fails to boot/u)
  assert.match(prompt, /boom/u)
})

test('a passing rehearsal narrows the task to the declarations', () => {
  const brief = buildBrief({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements: { a: '1' }, installedManifest: {},
    smokeReport: { ok: true, stages: [{ name: 'runtime', ok: true }] },
  })
  const prompt = renderPrompt(brief)
  assert.match(prompt, /boots successfully/u)
  assert.match(prompt, /only the declared ranges are out of date/u)
})

test('the prompt groups repeated ranges instead of printing one line per peer', () => {
  const requirements = {}
  for (let index = 0; index < 20; index += 1) requirements[`@deepseek-ai/pkg-${index}`] = '0.2.1-rc.3 || 0.2.1-rc.2'
  const brief = buildBrief({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.4',
    requirements, installedManifest: {}, smokeReport: { ok: true, stages: [] },
  })
  const prompt = renderPrompt(brief)
  const occurrences = (prompt.match(/0\.2\.1-rc\.3 \|\| 0\.2\.1-rc\.2/gu) ?? []).length
  assert.equal(occurrences, 1, 'the shared range must appear once, not twenty times')
  assert.match(prompt, /applies to 20 packages/u)
})

test('a rescue without a host version is refused instead of writing [null]', async () => {
  // A ledger entry born without a version can never match a real host, so it reads as a duplicate
  // of every later rescue for the same package.
  const dir = profile()
  await assert.rejects(
    () => rescuePlugin({
      profileDir: dir, dshDirectory: '/nonexistent', plugin: 'p@1.0.0',
      runtimeVersion: undefined, profile: 'test',
      rehearseImpl: async () => ({ verdict: 'runs', report: { stages: [] } }),
    }),
    /needs the exact host version/u,
  )
  assert.deepEqual(readExemptions(dir), {}, 'nothing may be written')
})

test('grantExemption refuses an empty runtime version', () => {
  const dir = profile()
  assert.throws(() => grantExemption(dir, { name: 'p', version: '1', runtimeVersion: '' }), /without a host version/u)
  assert.deepEqual(readExemptions(dir), {})
})

// --- the suggested range must be a value the maintainer can paste ---------------------

test('an enumeration of one line becomes a range that admits later builds only', () => {
  const result = suggestRange('0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4', '0.2.1-rc.5')
  assert.equal(result.suggested, '>=0.2.1-0 <0.2.2-0')
  assert.equal(result.keepsEnumeration, false)
})

test('the suggested range admits the new build but not the next host line', () => {
  const { suggested } = suggestRange('0.2.1-rc.1 || 0.2.1-rc.4', '0.2.1-rc.5')
  // Accepting 0.2.2 would claim a host line the author never vouched for, which is exactly the
  // mistake this tool exists to catch.
  assert.equal(semver.satisfies('0.2.1-rc.5', suggested, { includePrerelease: true }), true)
  assert.equal(semver.satisfies('0.2.1-rc.9', suggested, { includePrerelease: true }), true)
  assert.equal(semver.satisfies('0.2.1', suggested, { includePrerelease: true }), true)
  assert.equal(semver.satisfies('0.2.2-alpha.1', suggested, { includePrerelease: true }), false)
  assert.equal(semver.satisfies('0.3.0-0', suggested, { includePrerelease: true }), false)
})

test('an enumeration across several lines keeps them and opens only the newest', () => {
  const result = suggestRange('0.1.0-rc.2 || 0.2.0-rc.2 || 0.2.1-rc.4', '0.2.1-rc.5')
  assert.equal(result.keepsEnumeration, true, 'the author\'s history is preserved')
  assert.match(result.suggested, /^0\.1\.0-rc\.2 \|\| 0\.2\.0-rc\.2 \|\| 0\.2\.1-rc\.4 \|\| /u)
  assert.equal(semver.satisfies('0.2.1-rc.5', result.suggested, { includePrerelease: true }), true)
  assert.equal(semver.satisfies('0.2.2-alpha.1', result.suggested, { includePrerelease: true }), false)
})

test('a range that already covers the host reports no change rather than echoing itself', () => {
  const result = suggestRange('>=0.1.0-rc.6 <0.3.0-0', '0.2.1-rc.5')
  assert.equal(result.suggested, '>=0.1.0-rc.6 <0.3.0-0')
  assert.match(result.why, /already covers/u)
})

test('a range naming no concrete version asks for a manual decision', () => {
  const result = suggestRange('*', '0.2.1-rc.5')
  // '*' matches everything, so it is caught by the "already covers" branch first.
  assert.equal(result.suggested, '*')
  const odd = suggestRange('>=0.1.0', '9.9.9')
  assert.equal(odd.error, undefined)
})

test('suggestRange is total on empty and invalid input', () => {
  assert.equal(suggestRange('', '0.2.1-rc.5').error, 'empty range')
  assert.equal(suggestRange(undefined, '0.2.1-rc.5').error, 'empty range')
  assert.equal(suggestRange('0.2.1-rc.1', 'not-a-version').error, 'invalid runtime version')
})

test('buildReport carries the concrete edit, not a restatement of the problem', () => {
  const report = buildReport({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.5',
    requirements: { 'engines.dsh': '0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.4' },
    rehearsal: 'runs', toolVersion: '1.0.1',
  })
  assert.match(report.body, />=0\.2\.1-0 <0\.2\.2-0/u, 'the paste-ready value must appear')
  assert.match(report.body, /installs and boots/u)
  assert.doesNotMatch(report.body, /"engines\.dsh": "0\.2\.1-rc\.1 \|\| 0\.2\.1-rc\.2 \|\| 0\.2\.1-rc\.4"/u,
    'echoing the old range back is what the previous version did wrong')
})

test('buildReport warns when the suggestion keeps an enumeration', () => {
  const report = buildReport({
    name: 'p', version: '1.0.0', runtimeVersion: '0.2.1-rc.5',
    requirements: { 'engines.dsh': '0.1.0-rc.2 || 0.2.0-rc.2 || 0.2.1-rc.4' },
  })
  assert.match(report.body, /enumerate host versions deliberately/u)
})
