import test from 'node:test'
import assert from 'node:assert/strict'

import { executeToolCall, verifyTools } from '../src/runtime/worker.js'

// The tool execution contract changed between host lines, and both are in the field:
//
//   0.2.1.x  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>   — one call
//   0.2.2.x  execute(input: ToolBatchInput): Promise<ToolBatchResult>          — a batch
//
// The acceptance suite passed on 0.2.1-rc.5 and failed on 0.2.2-rc.1 with a ToolBatchExecutionError, which
// is what a single-call payload looks like to the batch API. These tests pin both paths so neither host line
// can regress silently.

/**
 * A tools service in the older shape: single call in, single result out.
 * @param {object} [options]
 */
function singleCallService({ value = 42 } = {}) {
  const calls = []
  return {
    calls,
    service: {
      get: (name) => ({ name }),
      // No `executable` — that is what marks the older contract.
      execute: async (exec) => {
        calls.push(exec)
        return { value, content: [] }
      },
    },
  }
}

/**
 * A tools service in the newer shape: a batch in, a batch out.
 * @param {object} [options]
 */
function batchService({ value = 42 } = {}) {
  const calls = []
  return {
    calls,
    service: {
      get: (name) => ({ name }),
      executable: (name) => ({ name }),
      execute: async (input) => {
        calls.push(input)
        return {
          results: input.calls.map((block) => ({ callId: block.id, result: { value, content: [] } })),
          additionalContexts: [],
          concluded: false,
        }
      },
    },
  }
}

/** A context whose `tools` slot holds the given service. */
const contextOf = (service) => ({ get: (name) => (name === 'tools' ? service : undefined) })

test('the older host gets a single call, unchanged', async () => {
  const { service, calls } = singleCallService()
  const result = await verifyTools(contextOf(service), ['t'], [{ name: 't', arguments: { a: 1 }, expectedValue: 42 }])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].callId, 'health-smoke-0')
  assert.equal(calls[0].name, 't')
  assert.deepEqual(calls[0].arguments, { a: 1 }, 'the older API takes parsed arguments')
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(result.executed, [{ name: 't', ok: true }])
  assert.equal(result.toolApi, 'single')
})

test('the newer host gets a batch of model-shaped calls', async () => {
  const { service, calls } = batchService()
  const result = await verifyTools(contextOf(service), ['t'], [{ name: 't', arguments: { a: 1 }, expectedValue: 42 }])

  assert.equal(calls.length, 1)
  const blocks = calls[0].calls
  assert.equal(blocks.length, 1, 'one assertion is one block')
  assert.equal(blocks[0].type, 'tool-call', 'the batch API expects model call blocks, tag included')
  assert.equal(blocks[0].id, 'health-smoke-0')
  assert.equal(blocks[0].name, 't')
  assert.equal(blocks[0].arguments, '{"a":1}', 'the newer API parses a raw JSON string')
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(result.executed, [{ name: 't', ok: true }])
  assert.equal(result.toolApi, 'batch')
})

test('the mode is chosen by capability, not by a version table', async () => {
  // A version list would need editing for every host release and would be wrong for anything not on it.
  // `executable()` is the feature that arrived with the batch contract.
  const { service } = batchService()
  const result = await verifyTools(contextOf(service), [], [{ name: 't', arguments: {} }])
  assert.equal(result.toolApi, 'batch')

  const older = singleCallService()
  const legacy = await verifyTools(contextOf(older.service), [], [{ name: 't', arguments: {} }])
  assert.equal(legacy.toolApi, 'single')
})

test('a tool that reports an error is still reported, in both shapes', async () => {
  const failing = {
    get: (name) => ({ name }),
    execute: async (exec) => ({ isError: true, error: { message: 'nope' }, content: [] }),
  }
  await assert.rejects(
    verifyTools(contextOf(failing), [], [{ name: 't', arguments: {} }]),
    /tool returned an error: t/u,
  )

  const failingBatch = {
    get: (name) => ({ name }),
    executable: (name) => ({ name }),
    execute: async (input) => ({
      results: input.calls.map((block) => ({ callId: block.id, result: { isError: true, error: { message: 'nope' }, content: [] } })),
      additionalContexts: [],
      concluded: false,
    }),
  }
  await assert.rejects(
    verifyTools(contextOf(failingBatch), [], [{ name: 't', arguments: {} }]),
    /tool returned an error: t/u,
  )
})

test('a mismatched value fails in both shapes', async () => {
  const wrongValue = singleCallService({ value: 7 })
  await assert.rejects(
    verifyTools(contextOf(wrongValue.service), [], [{ name: 't', arguments: {}, expectedValue: 42 }]),
    /unexpected value from t/u,
  )

  const wrongBatch = batchService({ value: 7 })
  await assert.rejects(
    verifyTools(contextOf(wrongBatch.service), [], [{ name: 't', arguments: {}, expectedValue: 42 }]),
    /unexpected value from t/u,
  )
})

test('a batch that comes back without the call is a failure, not a silent pass', async () => {
  // The whole point of verifying a call is that it happened. An empty batch must not read as success.
  const empty = {
    get: (name) => ({ name }),
    executable: (name) => ({ name }),
    execute: async () => ({ results: [], additionalContexts: [], concluded: false }),
  }
  await assert.rejects(
    verifyTools(contextOf(empty), [], [{ name: 't', arguments: {} }]),
    /no result for t/u,
  )
})

test('an unregistered tool is caught before anything executes', async () => {
  const { service, calls } = batchService()
  const withoutRegistration = { ...service, get: () => undefined }
  await assert.rejects(
    verifyTools(contextOf(withoutRegistration), ['ghost'], [{ name: 'ghost', arguments: {} }]),
    /tool did not register: ghost/u,
  )
  assert.equal(calls.length, 0, 'nothing should be dispatched for a tool that never registered')
})

test('executeToolCall can be called directly with an explicit mode', async () => {
  // Exported so the contract can be exercised without building a whole context.
  const { service, calls } = singleCallService({ value: 5 })
  const result = await executeToolCall(service, 'id-1', { name: 't', arguments: {} }, 'single')
  assert.equal(result.value, 5)
  assert.equal(calls[0].callId, 'id-1')
})