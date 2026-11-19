// The second axis: what a run could see of a plugin's own content.
//
// From ChenYichener in deepseek-ai/deepseek-harness#13379: one ✅ used to mean both "it installs" and
// "it works", and those claims have wildly different amounts of evidence behind them. Splitting them is
// only worth doing if `unknown` behaves as "we did not look" rather than as a soft failure.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DATA_STATES, dataState } from '../src/runtime/verify.js'

/** A smoke report carrying a readiness stage. */
const withReadiness = (stage) => ({ ok: true, stages: [{ name: 'readiness', ...stage }] })

test('a report with no readiness stage says unknown, and that is not a failure', () => {
  // Every plugin today. The point of the state is that "we did not look" must not read as "it works"
  // and must not read as "it is broken" either.
  for (const report of [undefined, null, {}, { ok: true, stages: [] }, { ok: true, stages: [{ name: 'runtime', ok: true }] }]) {
    const state = dataState(report)
    assert.equal(state.state, 'unknown', `expected unknown for ${JSON.stringify(report)}`)
    assert.notEqual(state.state, 'failed', 'unknown must never be reported as a problem')
  }
})

test('a plugin that declares no readiness check reports absent, not missing', () => {
  // `absent` exists so that "the author decided not to declare one" is a decision on the record rather
  // than a gap in the report. Without it, every plugin would look like it forgot something.
  const state = dataState(withReadiness({ skipped: true, detail: 'no readiness declaration' }))
  assert.equal(state.state, 'absent')
  assert.equal(state.detail, 'no readiness declaration')
})

test('a declared check that passed is observed, with whatever it reported', () => {
  const state = dataState(withReadiness({ ok: true, detail: 'lessons: 144' }))
  assert.equal(state.state, 'observed')
  assert.equal(state.detail, 'lessons: 144', 'the detail is the evidence; dropping it leaves a bare tick')
})

test('a declared check that failed is failed', () => {
  const state = dataState(withReadiness({ ok: false, detail: 'lessons: 0' }))
  assert.equal(state.state, 'failed')
  assert.equal(state.detail, 'lessons: 0')
})

test('a failed check without a detail still says something useful', () => {
  const state = dataState(withReadiness({ ok: false }))
  assert.equal(state.state, 'failed')
  assert.equal(typeof state.detail, 'string')
  assert.ok(state.detail.length > 0, 'a bare failure with no reason is not actionable')
})

test('the vocabulary is the four states and nothing else', () => {
  // Downstream code keys on these names, so the set is part of the contract.
  assert.deepEqual([...DATA_STATES], ['unknown', 'absent', 'observed', 'failed'])
  for (const report of [undefined, withReadiness({ skipped: true }), withReadiness({ ok: true }), withReadiness({ ok: false })]) {
    assert.ok(DATA_STATES.includes(dataState(report).state), `${dataState(report).state} is not in the vocabulary`)
  }
})

test('only failed is a problem — the other three must not read as one', () => {
  // The rule this whole axis exists to express.
  const states = [undefined, withReadiness({ skipped: true }), withReadiness({ ok: true })].map((report) => dataState(report).state)
  assert.ok(!states.includes('failed'), `no observed state should be failed, saw: ${states.join(', ')}`)
})