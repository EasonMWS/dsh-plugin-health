import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRescueHandlers, verdictMessage, RESCUE_PATH } from '../src/ui/rescue-route.js'

const profileContext = { home: '/home/x', profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }

test('rescue route is namespaced next to the other plugin-health routes', () => {
  assert.equal(RESCUE_PATH, '/plugins/dsh-plugin-health/rescue')
})

test('verdictMessage returns a locale key instead of deciding the language', () => {
  // The host cannot know which language the user reads, so it hands back a key and the
  // browser half translates it. The levels are what drive the colour.
  assert.deepEqual(verdictMessage('runs'), { level: 'ok', messageKey: 'rescueVerdictRuns' })
  assert.deepEqual(verdictMessage('broken'), { level: 'error', messageKey: 'rescueVerdictBrokenWhy' })
  assert.deepEqual(verdictMessage('inconclusive'), { level: 'warn', messageKey: 'rescueVerdictInconclusive' })
})

test('rehearse reports the verdict and whether applying is safe', async () => {
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    dshDirectoryOf: () => '/host/dsh',
    rehearseImpl: async ({ plugin, runtimeVersion }) => {
      assert.equal(plugin, 'p@1.0.0', 'the handler must pass an exact name@version')
      assert.equal(runtimeVersion, '0.2.1-rc.4')
      return { verdict: 'runs', report: { directory: '/tmp/run', hostVersion: '0.2.1-rc.4' } }
    },
  })
  const result = await handlers.rehearse({ plugin: 'p', version: '1.0.0' })
  assert.equal(result.verdict, 'runs')
  assert.equal(result.canApply, true)
  assert.equal(result.hostVersion, '0.2.1-rc.4')
})

test('rehearse refuses to offer apply when the rehearsal fails', async () => {
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    dshDirectoryOf: () => '/host/dsh',
    rehearseImpl: async () => ({ verdict: 'broken', report: { stages: [] } }),
  })
  const result = await handlers.rehearse({ plugin: 'p', version: '1.0.0' })
  assert.equal(result.canApply, false, 'the UI must not offer a button that cannot help')
})

test('when no host is installed the rehearsal downloads one instead of failing', async () => {
  // The desktop app bundles the host inside app.asar, so having no on-disk host is the normal
  // case there. Failing would make the feature unusable for the people it targets, so the first
  // rehearsal fetches its own copy. Injected here so the test never touches the network.
  let prepared
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    dshDirectoryOf: () => undefined,
    prepareHostImpl: async (options) => {
      prepared = options
      return { directory: '/downloaded/@deepseek-ai/dsh', installed: true }
    },
    rehearseImpl: async ({ dshDirectory }) => {
      assert.equal(dshDirectory, '/downloaded/@deepseek-ai/dsh', 'the downloaded host must be what gets booted')
      return { verdict: 'runs', report: { directory: '/tmp/run', hostVersion: '0.2.1-rc.4' } }
    },
  })
  const result = await handlers.rehearse({ plugin: 'p', version: '1.0.0' })
  assert.equal(result.verdict, 'runs')
  assert.equal(prepared.version, '0.2.1-rc.4', 'the download must match the host the user actually runs')
})

test('a host that cannot be downloaded surfaces the install failure', async () => {
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    dshDirectoryOf: () => undefined,
    prepareHostImpl: async () => {
      throw new Error('could not download a DSH host to rehearse against (@deepseek-ai/dsh@0.2.1-rc.4): network down')
    },
  })
  await assert.rejects(
    () => handlers.rehearse({ plugin: 'p', version: '1.0.0' }),
    /could not download a DSH host/u,
  )
})

test('rehearse requires a plugin and version', async () => {
  const handlers = createRescueHandlers({ currentProfile: () => profileContext, dshDirectoryOf: () => '/host/dsh' })
  await assert.rejects(() => handlers.rehearse({ plugin: 'p' }), /needs plugin and version/u)
})

test('apply always runs non-dry, so the route can only ever change the profile deliberately', async () => {
  let seen
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    dshDirectoryOf: () => '/host/dsh',
    rescueImpl: async (options) => {
      seen = options
      return { applied: true, verdict: 'runs', entry: { key: 'p@1.0.0' } }
    },
  })
  const result = await handlers.apply({ plugin: 'p', version: '1.0.0' })
  assert.equal(seen.dryRun, false)
  assert.equal(seen.profileDir, '/home/x/profiles/desktop')
  assert.equal(result.applied, true)
  assert.equal(result.verdict, 'runs')
})

test('undo forwards a specific key and reports how many remain', async () => {
  let seen
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    undoImpl: (profileDir, filter) => {
      seen = { profileDir, filter }
      return { undone: [{ key: 'p@1.0.0' }], remaining: [{ key: 'q@2.0.0' }] }
    },
  })
  const result = await handlers.undo({ key: 'p@1.0.0' })
  assert.deepEqual(seen.filter, { key: 'p@1.0.0' })
  assert.equal(result.remaining, 1)
})

test('undo without a key revokes every rescue for the profile', async () => {
  let seen
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    undoImpl: (profileDir, filter) => {
      seen = filter
      return { undone: [], remaining: [] }
    },
  })
  await handlers.undo({})
  assert.deepEqual(seen, {}, 'an unfiltered undo is a deliberate "clear them all"')
})

test('status merges the upstream verdict for every active rescue only', async () => {
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    auditImpl: () => [
      { key: 'a@1', name: 'a', version: '1', runtimeVersion: '0.2.1-rc.4', active: true },
      { key: 'b@1', name: 'b', version: '1', runtimeVersion: '0.2.1-rc.4', active: false },
    ],
    upstreamImpl: async ({ entries }) => {
      assert.equal(entries.length, 1, 'a revoked rescue needs no upstream lookup')
      return [{ key: 'a@1', status: 'fix-available', target: { fixed: '1.1.0' } }]
    },
  })
  const result = await handlers.status()
  assert.equal(result.entries[0].upstream, 'fix-available')
  assert.equal(result.entries[0].target.fixed, '1.1.0')
  assert.equal(result.entries[1].upstream, null)
})

test('handlers fail cleanly when the running profile is unknown', async () => {
  const handlers = createRescueHandlers({ currentProfile: () => ({}), dshDirectoryOf: () => '/host/dsh' })
  await assert.rejects(() => handlers.rehearse({ plugin: 'p', version: '1' }), /running profile is unknown/u)
})

test('handoff returns the prompt text but never sends it anywhere', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rescue-ui-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules', 'legacy'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'legacy', 'package.json'), JSON.stringify({
    name: 'legacy', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' },
    repository: 'https://github.com/o/r',
  }))
  try {
    const handlers = createRescueHandlers({
      currentProfile: () => ({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }),
      toolVersion: '9.9.9',
    })
    const result = await handlers.handoff({ plugin: 'legacy', version: '1.0.0', rehearsal: { ok: false, stages: [] } })
    assert.match(result.prompt, /legacy/u)
    assert.match(result.prompt, /Acceptance criteria/u)
    assert.ok(result.files.some(file => file.endsWith('prompt.md')))
    assert.equal(result.sent, undefined, 'the handler returns text; it must not report having sent anything')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('report checks upstream first and returns the draft without filing it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rescue-ui-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules', 'legacy'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'legacy', 'package.json'), JSON.stringify({
    name: 'legacy', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' },
    repository: 'https://github.com/o/r',
  }))
  const seen = []
  try {
    const handlers = createRescueHandlers({
      currentProfile: () => ({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }),
      toolVersion: '9.9.9',
      fetchImpl: async (url) => {
        seen.push(url)
        return { ok: true, json: async () => ({ items: [{ number: 7, title: 'existing', state: 'open', html_url: 'https://github.com/o/r/issues/7' }] }) }
      },
    })
    const result = await handlers.report({ plugin: 'legacy', version: '1.0.0' })
    assert.match(seen[0], /search\/issues/u, 'it must look for an existing report first')
    assert.equal(result.existing.length, 1)
    assert.match(result.newIssueUrl, /issues\/new/u)
    assert.match(result.body, /dsh-plugin-health-report/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('report refuses when the repository cannot be determined', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rescue-ui-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules', 'legacy'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'legacy', 'package.json'), JSON.stringify({
    name: 'legacy', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' },
  }))
  try {
    const handlers = createRescueHandlers({
      currentProfile: () => ({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }),
    })
    await assert.rejects(() => handlers.report({ plugin: 'legacy', version: '1.0.0' }), /cannot work out a GitHub repository/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('handoff and report reject a plugin that is not installed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rescue-ui-'))
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  try {
    const handlers = createRescueHandlers({
      currentProfile: () => ({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }),
    })
    await assert.rejects(() => handlers.handoff({ plugin: 'ghost', version: '1.0.0' }), /not installed/u)
    await assert.rejects(() => handlers.report({ plugin: 'ghost', version: '1.0.0' }), /not installed/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
