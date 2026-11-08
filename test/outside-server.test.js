import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readState, updateState } from '../src/state/shared.js'
import { startOutsideServer } from '../src/outside/server.js'

// The outside server changes profile state, so most of what matters here is what it refuses.

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'outside-'))
  const profileDir = join(dir, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: [] } }, dependencies: {},
  }), 'utf8')
  return { dir, profileDir }
}

async function withServer(fn, options = {}) {
  const { dir } = home()
  const server = await startOutsideServer({ home: dir, profile: 'desktop', key: 'k'.repeat(32), ...options })
  try {
    await fn({ server, home: dir })
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the state endpoint reports the shared state and the watch mode', async () => {
  await withServer(async ({ server, home: dir }) => {
    updateState(dir, (c) => ({ ...c, admission: { verdict: 'warn' } }), { writer: 'inside' })
    const response = await fetch(`${server.url}/state`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.state.admission.verdict, 'warn')
    assert.equal(body.state.rev, 1)
    assert.ok(['watch', 'poll'].includes(body.watchMode))
  })
})

test('the admission endpoint answers for the current profile', async () => {
  await withServer(async ({ server }) => {
    const response = await fetch(`${server.url}/admission`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(['pass', 'warn', 'block'].includes(body.verdict))
    assert.equal(body.profile, 'desktop')
    assert.ok(Array.isArray(body.limits) && body.limits.length > 0, 'a verdict carries its blind spots')
  })
})

test('a write without the key is refused', async () => {
  await withServer(async ({ server, home: dir }) => {
    const response = await fetch(`${server.url}/admission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ admission: { verdict: 'pass' } }),
    })
    assert.equal(response.status, 401)
    assert.equal(readState(dir).state.admission, null, 'nothing was written')
  })
})

test('a write with a wrong key is refused', async () => {
  await withServer(async ({ server, home: dir }) => {
    const response = await fetch(`${server.url}/admission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-health-key': 'wrong' },
      body: JSON.stringify({ admission: { verdict: 'pass' } }),
    })
    assert.equal(response.status, 401)
    assert.equal(readState(dir).state.admission, null)
  })
})

test('a write from another origin is refused even with the key', async () => {
  // The panel's routes use this rule for the same reason: a page on another local port must not be
  // able to drive writes, and holding the key should not be enough if the request came from elsewhere.
  await withServer(async ({ server, home: dir }) => {
    const response = await fetch(`${server.url}/admission`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-health-key': server.key,
        origin: 'http://127.0.0.1:1',
      },
      body: JSON.stringify({ admission: { verdict: 'pass' } }),
    })
    assert.equal(response.status, 403)
    assert.equal(readState(dir).state.admission, null)
  })
})

test('a write with the key and a matching origin lands', async () => {
  await withServer(async ({ server, home: dir }) => {
    const response = await fetch(`${server.url}/admission`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-health-key': server.key,
        origin: server.url,
      },
      body: JSON.stringify({ admission: { verdict: 'pass', fingerprint: 'abc' } }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(readState(dir).state.admission.verdict, 'pass')
    assert.equal(readState(dir).state.writer, 'outside')
  })
})

test('an intent can be queued and cleared', async () => {
  await withServer(async ({ server, home: dir }) => {
    const queued = await fetch(`${server.url}/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-health-key': server.key, origin: server.url },
      body: JSON.stringify({ op: 'disable-plugin', args: { name: 'dsh-winbox' } }),
    })
    assert.equal(queued.status, 200)
    const { intent } = await queued.json()
    assert.equal(intent.op, 'disable-plugin')
    assert.equal(intent.requestedBy, 'outside')
    assert.equal(readState(dir).state.pendingIntent.op, 'disable-plugin')

    const cleared = await fetch(`${server.url}/intent`, {
      method: 'DELETE',
      headers: { 'x-health-key': server.key, origin: server.url },
    })
    assert.equal(cleared.status, 200)
    assert.equal(readState(dir).state.pendingIntent, null)
  })
})

test('an intent without an operation is refused', async () => {
  await withServer(async ({ server, home: dir }) => {
    const response = await fetch(`${server.url}/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-health-key': server.key, origin: server.url },
      body: JSON.stringify({ args: { name: 'x' } }),
    })
    assert.equal(response.status, 400)
    assert.equal(readState(dir).state.pendingIntent, null)
  })
})

test('a change made through the server reaches an open event stream', async () => {
  // This is the point of the whole watching mechanism: a page open here updates when the panel inside
  // DSH writes, without a refresh.
  await withServer(async ({ server, home: dir }) => {
    const controller = new AbortController()
    const response = await fetch(`${server.url}/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/u)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const received = []
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received.push(decoder.decode(value))
        }
      } catch { /* aborted */ }
    })()

    // Let the stream attach, then have the *other* process write.
    await new Promise((r) => setTimeout(r, 150))
    updateState(dir, (c) => ({ ...c, admission: { verdict: 'block' } }), { writer: 'inside' })

    // Wait for the change, not for the greeting that opens the stream.
    const deadline = Date.now() + 3_000
    while (!received.some((chunk) => chunk.includes('"writer"')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
    }
    controller.abort()
    await pump

    // Skip the greeting that opens the stream; wait for the change itself.
    const change = received.find((chunk) => chunk.includes('"writer"'))
    assert.ok(change, `no change event arrived; received ${JSON.stringify(received)}`)
    assert.match(change, /"writer":"inside"/u)
    assert.match(change, /"rev":1/u)
  })
})

test('an unknown path is a 404, not a crash', async () => {
  await withServer(async ({ server }) => {
    const response = await fetch(`${server.url}/nope`)
    assert.equal(response.status, 404)
  })
})
