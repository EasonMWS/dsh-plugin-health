import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStatus, createStatusHandler, STATUS_PATH } from '../src/ui/status.js'

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-ui-'))
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dsh: { profile: { bundles: [] } },
  }))
  return home
}

test('status route path is under the plugin namespace', () => {
  assert.equal(STATUS_PATH, '/plugins/dsh-plugin-health/status')
})

test('buildStatus reports a healthy empty profile', () => {
  const home = tempHome()
  try {
    const status = buildStatus({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.2', now: 0 })
    // schemaVersion 3 added `rescuable`; 4 added `rescues`, the undo surface.
    assert.equal(status.schemaVersion, 4)
    assert.equal(status.profile, 'desktop')
    assert.equal(status.runtimeVersion, '0.2.1-rc.2')
    assert.equal(status.incompatible, 0)
    assert.equal(status.generatedAt, new Date(0).toISOString())
    assert.ok(Array.isArray(status.issues))
    assert.ok(Array.isArray(status.rescuable), 'the UI needs a machine-readable rescue list')
    assert.ok(Array.isArray(status.rescues), 'the UI needs the recorded exemptions to offer undo')
    // The UI says "checked N plugins"; the count must describe what was actually inspected.
    assert.equal(typeof status.scanned?.plugins?.total, 'number')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('buildStatus survives a missing DSH home', () => {
  const status = buildStatus({ home: join(tmpdir(), 'dsh-health-does-not-exist'), runtimeVersion: '0.2.1-rc.2' })
  assert.equal(status.profile, null)
  assert.equal(status.incompatible, 0)
  assert.ok(status.issues.some((issue) => issue.id === 'home-missing'))
})

function mockResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
  }
}

test('status handler rejects non-loopback hosts', async () => {
  const handler = createStatusHandler(() => ({ ok: true }))
  const response = mockResponse()
  await handler({ method: 'GET', headers: { host: 'evil.example.com' } }, response)
  assert.equal(response.statusCode, 403)
})

test('status handler rejects writes', async () => {
  const handler = createStatusHandler(() => ({ ok: true }))
  const response = mockResponse()
  await handler({ method: 'POST', headers: { host: '127.0.0.1:3080' } }, response)
  assert.equal(response.statusCode, 405)
})

test('status handler serves the snapshot on loopback', async () => {
  const handler = createStatusHandler(() => ({ schemaVersion: 1, issues: [] }))
  const response = mockResponse()
  await handler({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, response)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { schemaVersion: 1, issues: [] })
  assert.match(response.headers['content-type'], /application\/json/u)
})
