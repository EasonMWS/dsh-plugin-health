import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkStatusRequest, checkWriteRequest } from '../src/ui/guard.js'
import { createStatusHandler as createKeyStatus } from '../src/ui/repair-route.js'
import { createStatusHandler as createReadStatus } from '../src/ui/status.js'
import { createRescueHandlers, registerRescueRoute, RESCUE_PATH } from '../src/ui/rescue-route.js'

const HOST = '127.0.0.1:5140'
const KEY = 'k'.repeat(48)
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
function request(origin, encrypted = false) {
  return { method: 'POST', headers: { host: HOST, origin, 'content-type': 'application/json' }, socket: { encrypted } }
}
function recorder() {
  const result = {}
  return { result, res: { writeHead(status, headers) { Object.assign(result, { status, headers }) }, end(body) { result.body = JSON.parse(body) } } }
}

test('Origin validation includes scheme and applies to reads without Fetch Metadata', () => {
  for (const guard of [checkStatusRequest, checkWriteRequest]) {
    assert.equal(guard(request(`http://${HOST}`)).ok, true)
    assert.equal(guard(request(`https://${HOST}`)).ok, false)
    assert.equal(guard(request(`https://${HOST}`, true)).ok, true)
    assert.equal(guard(request(`http://${HOST}`, true)).ok, false)
    for (const origin of ['null', '', `http://evil@${HOST}`, `http://${HOST}/path`, `http://${HOST}?q=x`, 'http://127.0.0.1:3000']) {
      assert.equal(guard(request(origin)).ok, false, origin)
    }
    const forwarded = request(`https://${HOST}`)
    forwarded.headers['x-forwarded-proto'] = 'https'
    assert.equal(guard(forwarded).ok, false, 'a client cannot claim that the socket uses TLS')
  }
})

test('both status handlers reject another local origin before reading data or returning a key', async () => {
  for (const factory of [createKeyStatus, createReadStatus]) {
    let read = false
    const handler = factory(() => { read = true; return { issues: [] } }, KEY)
    const { result, res } = recorder()
    await handler({ ...request('http://127.0.0.1:3000'), method: 'GET' }, res)
    assert.equal(result.status, 403)
    assert.equal(read, false)
    assert.equal(result.body.key, undefined)
    assert.equal(result.headers['set-cookie'], undefined)
    assert.equal(result.headers['x-content-type-options'], 'nosniff')
  }
})

test('rescue action dispatch excludes inherited Object methods', async () => {
  const routes = new Map()
  const ctx = { inject: (_names, fn) => fn(ctx), effect: fn => fn(), webServer: { register: route => { routes.set(route.path, route.handler); return () => {} } } }
  registerRescueRoute(ctx, { key: KEY, currentProfile: () => ({}) })
  for (const action of ['constructor', 'toString', '__defineGetter__', '__proto__']) {
    const { result, res } = recorder()
    await routes.get(RESCUE_PATH)({
      ...request(`http://${HOST}`), url: `${RESCUE_PATH}/${action}`,
      headers: { ...request(`http://${HOST}`).headers, 'x-plugin-health-key': KEY },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
    }, res)
    assert.equal(result.status, 404, action)
  }
})

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'health-beta-security-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'desktop')
  const plugin = join(profileDir, 'node_modules', 'fixture')
  mkdirSync(plugin, { recursive: true })
  writeJson(join(plugin, 'package.json'), { name: 'fixture', version: '1.0.0' })
  let called = 0
  const handlers = createRescueHandlers({
    currentProfile: () => ({ home, profile: 'desktop', runtimeVersion: '0.2.1-rc.3' }),
    dshDirectoryOf: () => 'discovered-host',
    rehearseImpl: async ({ dshDirectory }) => { called++; return { verdict: 'runs', report: { directory: dshDirectory } } },
    rescueImpl: async () => { called++; return { applied: true, verdict: 'runs' } },
  })
  const host = join(home, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'cli.js'), '// fixture only')
  const manifest = { name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', bin: { dsh: './cli.js' } }
  writeJson(join(host, 'package.json'), manifest)
  return { home, host, plugin, handlers, manifest, calls: () => called }
}

test('request-supplied host checks identity, exact version, and executable containment', async (t) => {
  const f = fixture(t)
  const body = { plugin: 'fixture', version: '1.0.0', dshDirectory: f.host }
  assert.equal((await f.handlers.rehearse(body)).evidence, realpathSync(f.host))
  for (const changes of [{ name: 'unrelated' }, { version: '0.2.0' }, { bin: { dsh: '../outside.js' } }]) {
    writeFileSync(join(f.home, 'outside.js'), '// outside package')
    writeJson(join(f.host, 'package.json'), { ...f.manifest, ...changes })
    for (const action of ['rehearse', 'apply']) {
      await assert.rejects(() => f.handlers[action](body), /exact running|executable must resolve/u)
    }
  }
  assert.equal(f.calls(), 1, 'invalid host hints must never reach execution')
})

test('a junction cannot make a request-supplied host escape the DSH home', async (t) => {
  const f = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'health-beta-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const linked = join(f.home, 'linked-host')
  try {
    symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('this environment cannot create directory links')
      return
    }
    throw error
  }
  for (const action of ['rehearse', 'apply']) {
    await assert.rejects(() => f.handlers[action]({ plugin: 'fixture', version: '1.0.0', dshDirectory: linked }), /resolve inside/u)
  }
  assert.equal(f.calls(), 0)
})

test('an npm alias cannot cause rescue to run a different registry package', async (t) => {
  const f = fixture(t)
  writeJson(join(f.plugin, 'package.json'), { name: 'different-package', version: '1.0.0' })
  for (const action of ['rehearse', 'apply']) {
    await assert.rejects(() => f.handlers[action]({ plugin: 'fixture', version: '1.0.0' }), /not installed/u)
  }
  assert.equal(f.calls(), 0)
})
