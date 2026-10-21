import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepairHandler, createRepairKey, REPAIR_PATH } from '../src/ui/repair-route.js'

function fakeResponse() {
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

function fakeRequest({ method = 'POST', host = '127.0.0.1:3080', key, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: {
      host,
      ...(key === undefined ? {} : { 'x-plugin-health-key': key }),
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('repair route path is namespaced', () => {
  assert.equal(REPAIR_PATH, '/plugins/dsh-plugin-health/repair')
})

test('repair key is long and random', () => {
  const first = createRepairKey()
  const second = createRepairKey()
  assert.equal(first.length, 48)
  assert.notEqual(first, second)
})

test('repair handler rejects non-loopback hosts before auth', async () => {
  const handler = createRepairHandler({ key: 'k'.repeat(48) })
  const response = fakeResponse()
  await handler(fakeRequest({ host: 'evil.example.com', key: 'k'.repeat(48) }), response)
  assert.equal(response.statusCode, 403)
})

test('repair handler rejects a missing or wrong control key', async () => {
  const handler = createRepairHandler({ key: 'k'.repeat(48) })
  for (const request of [fakeRequest({}), fakeRequest({ key: 'x'.repeat(48) })]) {
    const response = fakeResponse()
    await handler(request, response)
    assert.equal(response.statusCode, 401)
  }
})

test('dry run plans but never writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-repair-ui-'))
  try {
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
      name: 'p',
      dsh: { profile: { bundles: [] } },
    }))
    const residue = join(home, 'profiles', 'desktop', 'package.json.bak-test')
    writeFileSync(residue, '{}')

    let applied
    const handler = createRepairHandler({
      key: 'k'.repeat(48),
      resolveProfile: () => ({ home, profile: 'desktop' }),
      apply: async (findings, options) => {
        applied = options
        return { dryRun: options.dryRun, actions: [], skipped: [] }
      },
    })
    const response = fakeResponse()
    await handler(fakeRequest({ key: 'k'.repeat(48), body: { dryRun: true } }), response)
    assert.equal(response.statusCode, 200)
    assert.equal(JSON.parse(response.body).dryRun, true)
    assert.equal(applied.dryRun, true)
    assert.equal(existsSync(residue), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('confirmed run applies the repair and quarantines the file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-repair-ui-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'p',
      dsh: { profile: { bundles: [] } },
    }))
    const residue = join(profileDir, 'package.json.bak-test')
    writeFileSync(residue, '{"stale":true}')

    const handler = createRepairHandler({
      key: 'k'.repeat(48),
      resolveProfile: () => ({ home, profile: 'desktop' }),
    })
    const response = fakeResponse()
    await handler(fakeRequest({ key: 'k'.repeat(48), body: { dryRun: false } }), response)
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.dryRun, false)
    assert.ok(body.actions.length >= 1)
    assert.equal(existsSync(residue), false, 'residue should move out of the profile')
    const quarantine = body.actions[0].to
    assert.equal(existsSync(quarantine), true, 'quarantine target should exist')
    assert.match(readFileSync(quarantine, 'utf8'), /stale/u)
    assert.equal(existsSync(join(home, '.plugin-health', 'quarantine')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
