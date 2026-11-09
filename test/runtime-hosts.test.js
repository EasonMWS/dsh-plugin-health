import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveRuntimeHosts, BASELINE_HOST } from '../scripts/resolve-runtime-hosts.mjs'
import { checkHostContract, FIBER_ACTIVE, verifyActivation } from '../src/runtime/worker.js'

// The runtime acceptance job validated two pinned hosts while the current release was another one entirely,
// so it was checking releases nobody runs. These tests pin both halves of the fix: which hosts get picked,
// and what happens when the host's own state enum no longer matches the constant this tool relies on.

// ---------- which hosts ----------

test('latest and next are taken from the registry, deduplicated', () => {
  // `next` and `latest` point at the same version most days; testing it twice spends a job to learn nothing.
  assert.deepEqual(
    resolveRuntimeHosts({ latest: '0.2.2-rc.1', next: '0.2.2-rc.1', alpha: '0.2.2-alpha.3' }),
    ['0.2.2-rc.1', BASELINE_HOST],
  )
  assert.deepEqual(
    resolveRuntimeHosts({ latest: '0.2.2-rc.1', next: '0.2.3-rc.1' }),
    ['0.2.2-rc.1', '0.2.3-rc.1', BASELINE_HOST],
  )
})

test('the fixed baseline is always tested, even when a tag points at it', () => {
  // A change that only breaks on the previous line still has to be caught.
  const hosts = resolveRuntimeHosts({ latest: BASELINE_HOST })
  assert.deepEqual(hosts, [BASELINE_HOST])
  assert.equal(hosts.filter((host) => host === BASELINE_HOST).length, 1, 'no duplicate baseline')
})

test('a missing or empty tag is skipped rather than becoming an empty matrix entry', () => {
  // An empty string in the matrix would make the install step fail with a confusing message.
  assert.deepEqual(resolveRuntimeHosts({ latest: '0.2.2-rc.1', next: '' }), ['0.2.2-rc.1', BASELINE_HOST])
  assert.deepEqual(resolveRuntimeHosts({}), [BASELINE_HOST])
})

// ---------- the host contract ----------

/** A context whose loader reports the given entries. */
function ctxWith(entries) {
  return { get: (name) => (name === 'loader' ? { entries: () => entries } : undefined) }
}

/** One loader entry. */
function entry({ name = '@deepseek-ai/dsh-base', state = FIBER_ACTIVE, disabled = false, id = name } = {}) {
  return { disabled, options: { name, id }, fiber: state === undefined ? undefined : { state } }
}

test('the activation constant is the value cordis documents', () => {
  // If this changes, checkHostContract is what turns the resulting confusion into a clear message.
  assert.equal(FIBER_ACTIVE, 2)
})

test('a host whose state enum moved is reported as a contract change, not as a broken plugin', () => {
  // This is the whole point: with a different enum, every assertion below would say "did not activate" and
  // send the reader after their own plugin.
  const ctx = ctxWith([
    entry({ name: '@deepseek-ai/dsh-base', state: 3 }),
    entry({ name: '@deepseek-ai/dsh-app-boot', state: 3 }),
  ])
  assert.throws(() => checkHostContract(ctx), (error) => {
    assert.match(error.message, /^host-contract-changed:/u)
    assert.match(error.message, /nothing about the plugin under test/u)
    return true
  })
})

test('when the official entries are active, the contract check passes quietly', () => {
  const ctx = ctxWith([
    entry({ name: '@deepseek-ai/dsh-base', state: FIBER_ACTIVE }),
    entry({ name: '@deepseek-ai/dsh-app-boot', state: FIBER_ACTIVE }),
  ])
  assert.deepEqual(checkHostContract(ctx), { checked: 2, active: 2 })
})

test('one active official entry is enough: a disabled sibling does not trigger a false alarm', () => {
  const ctx = ctxWith([
    entry({ name: '@deepseek-ai/dsh-base', state: FIBER_ACTIVE }),
    entry({ name: '@deepseek-ai/dsh-web-app', state: 3, disabled: true }),
  ])
  assert.deepEqual(checkHostContract(ctx), { checked: 1, active: 1 })
})

test('a profile with no official entries is not treated as a contract change', () => {
  // An unusual layout is not evidence that the enum moved.
  assert.deepEqual(checkHostContract(ctxWith([])), { checked: 0, active: 0 })
  assert.deepEqual(checkHostContract(ctxWith([entry({ name: 'dsh-third-party', state: 3 })])), { checked: 0, active: 0 })
})

test('a plugin that did not activate is still reported as a plugin problem', () => {
  // The distinction the contract check must not blur: host fine, plugin broken. The general "entries did not
  // activate" assertion fires first, which is existing behaviour — what matters is that the message names the
  // plugin and does not blame the host contract.
  const ctx = ctxWith([
    entry({ name: '@deepseek-ai/dsh-base', state: FIBER_ACTIVE }),
    entry({ name: 'dsh-under-test', state: 3 }),
  ])
  checkHostContract(ctx)
  assert.throws(() => verifyActivation(ctx, { plugin: 'dsh-under-test' }), (error) => {
    assert.match(error.message, /dsh-under-test/u)
    assert.doesNotMatch(error.message, /host-contract-changed/u)
    return true
  })
})