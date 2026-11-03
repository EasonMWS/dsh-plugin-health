import test from 'node:test'
import assert from 'node:assert/strict'

import { checkStatusRequest, checkWriteRequest } from '../src/ui/guard.js'

// A page served from another local port is same-*site* with the DSH origin — cookies ignore the port
// — so it carries the control cookie without ever reading it. These checks are what stop it, and
// they are the only thing standing between a local dev server and "install and run any npm package".

const HOST = '127.0.0.1:5140'

function post(overrides = {}) {
  return {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json', ...overrides },
  }
}

test('a plain same-origin JSON write is allowed', () => {
  assert.deepEqual(checkWriteRequest(post()), { ok: true })
})

test('a text/plain write is refused, because it would skip the preflight', () => {
  // CORS simple requests need no preflight; requiring JSON forces one, and the routes answer the
  // preflight with 405 and no CORS headers.
  const result = checkWriteRequest(post({ 'content-type': 'text/plain' }))
  assert.equal(result.ok, false)
  assert.equal(result.status, 415)
})

test('a JSON write from another local port is refused', () => {
  const result = checkWriteRequest(post({ origin: 'http://127.0.0.1:3000' }))
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
})

test('a matching Origin is allowed', () => {
  assert.deepEqual(checkWriteRequest(post({ origin: `http://${HOST}` })), { ok: true })
})

test('Sec-Fetch-Site stops a cross-site page even without an Origin header', () => {
  for (const site of ['cross-site', 'same-site']) {
    const result = checkWriteRequest(post({ 'sec-fetch-site': site }))
    assert.equal(result.ok, false, `${site} must be refused`)
    assert.equal(result.status, 403)
  }
})

test('same-origin and none are accepted for Sec-Fetch-Site', () => {
  for (const site of ['same-origin', 'none']) {
    assert.deepEqual(checkWriteRequest(post({ 'sec-fetch-site': site })), { ok: true })
  }
})

test('an unparseable Origin is refused rather than ignored', () => {
  assert.equal(checkWriteRequest(post({ origin: 'null' })).ok, false)
})

test('read methods are not subject to the write guard', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.deepEqual(checkWriteRequest({ method, headers: { host: HOST, 'sec-fetch-site': 'cross-site' } }), { ok: true })
  }
})

test('a body-less POST with no content type is still allowed', () => {
  // `undo` and friends take no arguments; refusing them would break the UI for no gain.
  assert.deepEqual(checkWriteRequest({ method: 'POST', headers: { host: HOST } }), { ok: true })
})

test('the status route refuses to seed the cookie for a cross-site page', () => {
  const result = checkStatusRequest({ method: 'GET', headers: { host: HOST, 'sec-fetch-site': 'same-site' } })
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
})

test('the status route still answers a normal browser navigation', () => {
  assert.deepEqual(checkStatusRequest({ method: 'GET', headers: { host: HOST, 'sec-fetch-site': 'same-origin' } }), { ok: true })
  assert.deepEqual(checkStatusRequest({ method: 'GET', headers: { host: HOST } }), { ok: true })
})