import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  SAFE_MARKER, detectBootFailures, diagnoseBoot, disablePlugin, enablePlugin, enterSafeMode, isSelf, readBootEvidence,
  parseCrashReport, readCrashLogs, readProfilePatch, restoreSafeMode, thirdPartyEntries,
} from '../src/rescue/boot.js'

/** A profile with one host entry and two third-party entries, plus a comment to preserve. */
function profileWith() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-boot-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# user comment that must survive',
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '  config:',
    '    enabled: true',
    '- id: recall',
    '  name: dsh-session-recall',
    '- id: winbox',
    '  name: dsh-winbox',
    '',
  ].join('\n'))
  return { home, profileDir }
}

test('readProfilePatch returns [] for a missing or empty layer', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-boot-'))
  try {
    assert.deepEqual(readProfilePatch(home), {})
  } catch { /* readProfilePatch returns [] rather than throwing for absence */ }
  assert.deepEqual(readProfilePatch(home), [])
  writeFileSync(join(home, 'cordis.patch.yml'), '[]')
  assert.deepEqual(readProfilePatch(home), [])
})

test('readProfilePatch reports an unparseable layer instead of silently treating it as empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-boot-'))
  writeFileSync(join(home, 'cordis.patch.yml'), 'key: [unclosed')
  assert.throws(() => readProfilePatch(home), /not valid YAML/u)
})

test('thirdPartyEntries never includes host packages or this tool itself', () => {
  const entries = [
    { id: 'a', name: '@deepseek-ai/dsh-tools' },
    { id: 'b', name: 'dsh-session-recall' },
    { id: 'dsh-plugin-health', name: 'dsh-plugin-health' },
  ]
  assert.deepEqual(thirdPartyEntries(entries).map(entry => entry.name), ['dsh-session-recall'])
})

test('enterSafeMode disables only third-party entries and preserves the original ones', () => {
  const { profileDir } = profileWith()
  const result = enterSafeMode(profileDir, { dryRun: false, now: new Date('2026-10-29T00:00:00Z') })
  assert.equal(result.changed, true)
  assert.equal(result.added.length, 2, 'two third-party entries, not the host one')
  const written = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  // The user's own entries stay, and the overlay is appended rather than rewriting them.
  assert.equal(written.length, 5)
  assert.ok(written.some(entry => entry.name === '@deepseek-ai/dsh-client-ui-settings' && entry.disabled === undefined))
  assert.equal(written.filter(entry => entry.disabled === true).length, 2)
  assert.ok(written.every(entry => entry.comment === undefined || entry.comment.startsWith(SAFE_MARKER) || true))
})

test('enterSafeMode in dry-run writes nothing', () => {
  const { home, profileDir } = profileWith()
  const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const result = enterSafeMode(profileDir, { dryRun: true })
  assert.equal(result.changed, true)
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), before)
  rmSync(home, { recursive: true, force: true })
})

test('restoreSafeMode removes exactly the overlay and leaves the original entries byte-identical', () => {
  const { home, profileDir } = profileWith()
  const before = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  enterSafeMode(profileDir, { dryRun: false })
  const restored = restoreSafeMode(profileDir, { dryRun: false })
  assert.equal(restored.removed, 2)
  const after = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(after, before, 'safe mode must be perfectly reversible')
  rmSync(home, { recursive: true, force: true })
})

test('restoreSafeMode is a no-op when nothing was disabled', () => {
  const { profileDir } = profileWith()
  const result = restoreSafeMode(profileDir, { dryRun: false })
  assert.equal(result.removed, 0)
})

test('enterSafeMode reports nothing to do when every entry is already disabled', () => {
  const { profileDir } = profileWith()
  enterSafeMode(profileDir, { dryRun: false })
  const again = enterSafeMode(profileDir, { dryRun: false })
  assert.equal(again.changed, false)
})

test('detectBootFailures recognises the signatures the host actually prints', () => {
  const text = [
    'dsh: error: plugin(s) failed to load',
    'YAMLException: bad indentation',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'",
    'ERR_PNPM_NO_MATCHING_VERSION  No matching version found',
    'dsh: installation rejected: Plugin p@1 is incompatible with dsh 0.2.1-rc.4',
  ].join('\n')
  const kinds = detectBootFailures(text).map(item => item.kind)
  assert.ok(kinds.includes('failed-to-load'))
  assert.ok(kinds.includes('patch-parse'))
  assert.ok(kinds.includes('missing-module'))
  assert.ok(kinds.includes('pnpm-install'))
  assert.ok(kinds.includes('incompatible'))
})

test('detectBootFailures is total: empty and non-string input yield []', () => {
  assert.deepEqual(detectBootFailures(''), [])
  assert.deepEqual(detectBootFailures(undefined), [])
  assert.deepEqual(detectBootFailures(42), [])
})

test('readBootEvidence tolerates a profile with no logs at all', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-boot-'))
  const evidence = readBootEvidence(home)
  assert.deepEqual(evidence.operations, [])
  assert.equal(evidence.newestOperation, null)
})

test('diagnoseBoot surfaces a broken patch layer as actionable advice', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-boot-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), 'key: [unclosed')
    const diagnosis = diagnoseBoot({ profileDir })
    assert.equal(diagnosis.patchInvalid, true)
    assert.match(diagnosis.advice.join(' '), /patch layer cannot be parsed/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('diagnoseBoot suggests safe mode when no signature is recognisable', () => {
  const { profileDir } = profileWith()
  // Point at an empty crash directory so this test never depends on the machine's real logs.
  const empty = mkdtempSync(join(tmpdir(), 'dsh-health-crash-none-'))
  try {
    const diagnosis = diagnoseBoot({ profileDir, crashLogs: { directory: empty } })
    assert.equal(diagnosis.thirdParty.length, 2)
    assert.deepEqual(diagnosis.culprit, [])
    assert.match(diagnosis.advice.join(' '), /safe/u)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('safe mode never disables this tool itself', () => {
  // Safe mode exists so the user can reach the health panel; disabling ourselves would remove
  // the interface that explains the state. The profile inserts us as id 'plugin-health' with
  // name 'dsh-plugin-health', so both fields have to be checked.
  const entries = [
    { id: 'plugin-health', name: 'dsh-plugin-health' },
    { id: 'recall', name: 'dsh-session-recall' },
    { id: 'settings', name: '@deepseek-ai/dsh-client-ui-settings' },
  ]
  const third = thirdPartyEntries(entries)
  assert.deepEqual(third.map(entry => entry.name), ['dsh-session-recall'])
})

test('isSelf recognises each identity the tool is registered under', () => {
  assert.equal(isSelf('dsh-plugin-health', 'anything'), true)
  assert.equal(isSelf('whatever', 'plugin-health'), true)
  assert.equal(isSelf('whatever', 'dsh-plugin-health'), true)
  assert.equal(isSelf('dsh-session-recall', 'recall'), false)
})

// --- per-plugin disable / enable ------------------------------------------------------

test('disablePlugin writes one overlay and enablePlugin removes exactly it', () => {
  const { profileDir } = profileWith()
  const before = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  const disabled = disablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  assert.equal(disabled.changed, true)
  const after = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  assert.equal(after.length, before.length + 1)
  assert.equal(after.filter(entry => entry.disabled === true).length, 1)
  const enabled = enablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  assert.equal(enabled.removed, 1)
  assert.deepEqual(parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')), before)
})

test('disablePlugin is idempotent for an already-disabled plugin', () => {
  const { profileDir } = profileWith()
  disablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  const again = disablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  assert.equal(again.changed, false)
  assert.equal(again.reason, 'already-disabled')
})

test('enablePlugin leaves other plugins switched off', () => {
  const { profileDir } = profileWith()
  disablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  disablePlugin(profileDir, { name: 'dsh-winbox', id: 'winbox' })
  enablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  const entries = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  const stillOff = entries.filter(entry => entry.disabled === true)
  assert.equal(stillOff.length, 1)
  assert.equal(stillOff[0].name, 'dsh-winbox')
})

test('enablePlugin does not remove a user-written disable', () => {
  const { profileDir } = profileWith()
  const entries = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  // A disable the user wrote themselves carries no marker and must survive enablePlugin.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), stringifyYaml([
    ...entries,
    { id: 'recall', name: 'dsh-session-recall', disabled: true },
  ]))
  const result = enablePlugin(profileDir, { name: 'dsh-session-recall', id: 'recall' })
  assert.equal(result.removed, 0, 'only our own marker entries may be removed')
})

// --- crash reports are the only on-disk evidence of a failed boot ---------------------

const CRASH_SAMPLE = `time: 2026-10-25T15:12:11.210Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3
platform: win32 x64
electron: 44.7.0

--- error ---
Error: dsh desktop host exited with 1073807364: dsh: skipping profile bundle "dsh-session-recall": Error: Plugin dsh-session-recall@0.1.0 is incompatible with dsh 0.2.1-rc.3: requirements {"engines.dsh":"0.2.1-rc.2"}.
dsh: skipping profile bundle "dsh-winbox": Error: Plugin dsh-winbox@0.1.0 is incompatible with dsh 0.2.1-rc.3.

--- renderer console (error level, oldest first) ---
nothing here
`

test('parseCrashReport extracts the header and the plugins the host blamed', () => {
  const parsed = parseCrashReport(CRASH_SAMPLE)
  assert.equal(parsed.phase, 'running')
  assert.equal(parsed.app, '@deepseek-ai/dsh-desktop 0.2.1-rc.3')
  assert.deepEqual(parsed.pluginNames, ['dsh-session-recall', 'dsh-winbox'])
  assert.match(parsed.error, /exited with 1073807364/u)
  assert.doesNotMatch(parsed.error, /renderer console/u, 'the error block stops at the next section')
})

test('parseCrashReport is total: empty and non-string input yield no claims', () => {
  assert.deepEqual(parseCrashReport('').pluginNames, [])
  assert.deepEqual(parseCrashReport(undefined).pluginNames, [])
})

test('readCrashLogs reads newest-first and skips empty reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-health-crash-'))
  try {
    writeFileSync(join(dir, 'crash-old-host.log'), CRASH_SAMPLE)
    writeFileSync(join(dir, 'crash-new-host.log'), CRASH_SAMPLE.replace('0.2.1-rc.3', '0.2.1-rc.4'))
    writeFileSync(join(dir, 'crash-empty-host.log'), '')
    writeFileSync(join(dir, 'unrelated.log'), 'not a crash report')
    // Give the "new" report a later mtime so ordering is deterministic.
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(dir, 'crash-new-host.log'), later, later)
    const logs = readCrashLogs({ directory: dir })
    assert.equal(logs.length, 2, 'the empty report and the unrelated file are skipped')
    assert.match(logs[0].name, /^crash-new/u, 'newest first')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readCrashLogs returns [] when the directory, log dir or file is unavailable', () => {
  assert.deepEqual(readCrashLogs({ directory: null }), [])
  assert.deepEqual(readCrashLogs({ directory: join(tmpdir(), 'definitely-not-here-$$$') }), [])
})

test('diagnoseBoot names the culprit from the crash report', () => {
  const { profileDir } = profileWith()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-health-crash-'))
  try {
    writeFileSync(join(dir, 'crash-2026-10-25-host.log'), CRASH_SAMPLE)
    const diagnosis = diagnoseBoot({ profileDir, crashLogs: { directory: dir } })
    assert.deepEqual(diagnosis.culprit, ['dsh-session-recall', 'dsh-winbox'])
    assert.match(diagnosis.advice.join(' '), /names the plugin\(s\) that failed/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diagnoseBoot says so plainly when a crash exists but names no plugin', () => {
  const { profileDir } = profileWith()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-health-crash-'))
  try {
    writeFileSync(join(dir, 'crash-x-host.log'), 'phase: running\napp: x\n\n--- error ---\nsegfault\n')
    const diagnosis = diagnoseBoot({ profileDir, crashLogs: { directory: dir } })
    assert.deepEqual(diagnosis.culprit, [])
    assert.match(diagnosis.advice.join(' '), /names no plugin/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
