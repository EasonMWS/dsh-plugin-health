import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_INTERVAL_MS,
  CURRENT_VERSION,
  compareVersions,
  fetchLatestVersion,
  refreshUpdate,
  resetUpdateStateForTests,
  snapshot,
  startAutoCheck,
  upgradeHint,
} from '../src/ui/update.js'

// The update check is the only thing in this package that reaches the network on its own, and it runs
// at every boot. Two properties have to hold no matter what the registry does: it never blocks, and it
// never claims something it did not learn.

function registryReturning(version, { calls } = { calls: { n: 0 } }) {
  return async () => {
    calls.n += 1
    return { ok: true, status: 200, json: async () => ({ version }) }
  }
}

function registryFailing(message = 'network down') {
  return async () => {
    throw new Error(message)
  }
}

test('the current version is read from the package itself', () => {
  assert.match(CURRENT_VERSION ?? '', /^\d+\.\d+\.\d+/u)
})

test('a newer version is reported as available', async () => {
  resetUpdateStateForTests()
  const state = await refreshUpdate({ force: true, fetchImpl: registryReturning('99.0.0') })
  assert.equal(state.status, 'ok')
  assert.equal(state.latestVersion, '99.0.0')
  assert.equal(state.updateAvailable, true)
  assert.equal(state.currentVersion, CURRENT_VERSION)
  assert.match(snapshot().upgradeHint ?? '', /dsh plugin .* add dsh-plugin-health@99\.0\.0/u)
})

test('the same version is not an update', async () => {
  resetUpdateStateForTests()
  const state = await refreshUpdate({ force: true, fetchImpl: registryReturning(CURRENT_VERSION) })
  assert.equal(state.updateAvailable, false)
  assert.equal(snapshot().upgradeHint, null)
})

test('an older published version is not an update either', async () => {
  resetUpdateStateForTests()
  const state = await refreshUpdate({ force: true, fetchImpl: registryReturning('0.0.1') })
  assert.equal(state.updateAvailable, false)
})

test('a failure is recorded, not thrown — and it never reads as "up to date"', async () => {
  resetUpdateStateForTests()
  const state = await refreshUpdate({ force: true, fetchImpl: registryFailing() })
  assert.equal(state.status, 'error')
  assert.match(state.error, /network down/u)
  assert.equal(state.updateAvailable, false)
  // The distinction matters: "could not check" must not be shown as "you are current".
  assert.notEqual(state.status, 'ok')
})

test('a registry that answers without a version is a failure, not a silent pass', async () => {
  resetUpdateStateForTests()
  const state = await refreshUpdate({ force: true, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  assert.equal(state.status, 'error')
})

test('a non-200 answer is a failure', async () => {
  resetUpdateStateForTests()
  const state = await refreshUpdate({ force: true, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  assert.equal(state.status, 'error')
  assert.match(state.error, /503/u)
})

test('the automatic path is throttled, the explicit one is not', async () => {
  resetUpdateStateForTests()
  const calls = { n: 0 }
  const fetchImpl = registryReturning('99.0.0', { calls })
  await refreshUpdate({ fetchImpl })
  const afterFirst = calls.n
  await refreshUpdate({ fetchImpl })
  assert.equal(calls.n, afterFirst, 'a second automatic check within the interval must not hit the network')
  await refreshUpdate({ fetchImpl, force: true })
  assert.equal(calls.n, afterFirst + 1, 'an explicit check always does')
})

test('concurrent callers share one request', async () => {
  resetUpdateStateForTests()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { ok: true, status: 200, json: async () => ({ version: '99.0.0' }) }
  }
  await Promise.all([
    refreshUpdate({ force: true, fetchImpl }),
    refreshUpdate({ force: true, fetchImpl }),
    refreshUpdate({ force: true, fetchImpl }),
  ])
  assert.equal(calls, 1, 'three panels opening at once must not make three requests')
})

test('the environment variable turns the automatic check off', () => {
  resetUpdateStateForTests()
  const previous = process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
  process.env.DSH_PLUGIN_HEALTH_NO_UPDATE = '1'
  try {
    // startAutoCheck is fire-and-forget; the observable contract is that it issues no request.
    let called = 0
    const original = globalThis.fetch
    globalThis.fetch = async () => { called += 1; throw new Error('should not be called') }
    try {
      startAutoCheck()
    } finally {
      globalThis.fetch = original
    }
    assert.equal(called, 0)
    assert.equal(snapshot().status, 'never')
  } finally {
    if (previous === undefined) delete process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
    else process.env.DSH_PLUGIN_HEALTH_NO_UPDATE = previous
  }
})

test('the boot-time check never rejects, whatever the registry does', async () => {
  resetUpdateStateForTests()
  // startAutoCheck returns void by contract; awaiting a rejection here would crash a host boot.
  assert.equal(startAutoCheck(), undefined)
})

test('fetchLatestVersion hits this package on the registry it is given', async () => {
  let seen
  const version = await fetchLatestVersion({
    registry: 'https://example.test/npm/',
    fetchImpl: async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({ version: '1.2.3' }) } },
  })
  assert.equal(version, '1.2.3')
  assert.equal(seen, 'https://example.test/npm/dsh-plugin-health/latest')
})

test('the upgrade hint names the version so a stale one cannot be installed', () => {
  assert.match(upgradeHint('2.1.0'), /dsh-plugin-health@2\.1\.0$/u)
  assert.match(upgradeHint(undefined), /dsh-plugin-health$/u)
})

test('version comparison orders prereleases below their release', () => {
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0)
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  // A prerelease of a version is older than that version — rc.5 is not newer than 0.2.1.
  assert.ok(compareVersions('0.2.2-alpha.3', '0.2.2') < 0)
  assert.ok(compareVersions('0.2.1-rc.5', '0.2.1') < 0)
  assert.ok(compareVersions('0.2.1-rc.5', '0.2.1-rc.6') < 0)
})

test('the automatic interval is finite, so a long-running host re-checks', () => {
  assert.ok(AUTO_INTERVAL_MS > 0 && AUTO_INTERVAL_MS <= 24 * 60 * 60 * 1000)
})