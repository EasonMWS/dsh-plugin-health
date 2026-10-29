import test from 'node:test'
import assert from 'node:assert/strict'

import { createRescueHandlers, verdictMessage, RESCUE_PATH } from '../src/ui/rescue-route.js'

const profileContext = { home: '/home/x', profile: 'desktop', runtimeVersion: '0.2.1-rc.4' }

test('rescue route is namespaced next to the other plugin-health routes', () => {
  assert.equal(RESCUE_PATH, '/plugins/dsh-plugin-health/rescue')
})

test('verdictMessage never promises that an exemption fixes a broken plugin', () => {
  const runs = verdictMessage('runs')
  assert.equal(runs.level, 'ok')
  assert.match(runs.message, /loads on your DSH version once the version requirement is exempted/u)

  const broken = verdictMessage('broken')
  assert.equal(broken.level, 'error')
  assert.match(broken.message, /nothing was changed/u, 'a broken verdict must say the profile was left alone')

  const unknown = verdictMessage('inconclusive')
  assert.equal(unknown.level, 'warn')
  assert.match(unknown.message, /nothing was changed/u)
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

test('rehearse fails with a readable reason when no host is installed', async () => {
  const handlers = createRescueHandlers({
    currentProfile: () => profileContext,
    dshDirectoryOf: () => undefined,
  })
  await assert.rejects(
    () => handlers.rehearse({ plugin: 'p', version: '1.0.0' }),
    /no installed @deepseek-ai\/dsh/u,
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
