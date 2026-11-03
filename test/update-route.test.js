import test from 'node:test'
import assert from 'node:assert/strict'

import { registerRescueRoute } from '../src/ui/rescue-route.js'
import { UPDATE_PATH } from '../src/ui/update.js'

// "Check for updates" is the only control in this plugin that reaches the network, so its route has
// to sit behind exactly the fence the other write routes use. These tests drive the *real*
// registration rather than a stand-in, because the wiring is the thing that was never covered: the
// guard function was already tested, the question here is whether this route is actually behind it.

const KEY = 'k'.repeat(48)
const HOST = '127.0.0.1:5140'

/** Mount the routes on a fake web server and hand back the captured handlers. */
function mount({ refreshUpdateImpl } = {}) {
  const routes = new Map()
  const ctx = {
    inject: (_names, fn) => fn(ctx),
    effect: (fn) => fn(),
    webServer: {
      register: ({ kind, path, handler }) => {
        routes.set(kind === 'exact' ? path : `${kind}:${path}`, handler)
        return () => routes.delete(path)
      },
    },
  }
  let refreshed = 0
  registerRescueRoute(ctx, {
    currentProfile: () => ({ home: '/tmp/home', profile: 'desktop', profileDir: '/tmp/home/profiles/desktop', runtimeVersion: '0.2.1-rc.5' }),
    key: KEY,
    toolVersion: '2.0.0',
    refreshUpdateImpl: refreshUpdateImpl ?? (async () => {
      refreshed += 1
      return {
        currentVersion: '2.0.0', latestVersion: '2.0.1', updateAvailable: true,
        status: 'ok', checkedAt: '2026-11-03T15:00:00Z', error: null,
      }
    }),
  })
  return { routes, calls: () => refreshed }
}

/** A response recorder. */
function recorder() {
  const captured = { status: 0, body: undefined, headers: undefined }
  return {
    captured,
    res: {
      writeHead(status, headers) { captured.status = status; captured.headers = headers },
      end(payload) { captured.body = payload === undefined ? undefined : JSON.parse(payload) },
    },
  }
}

function request(overrides = {}) {
  return {
    method: 'POST',
    url: UPDATE_PATH,
    headers: { host: HOST, 'content-type': 'application/json', ...overrides },
    async *[Symbol.asyncIterator]() {},
  }
}

test('the update route is registered next to the rescue route', () => {
  const { routes } = mount()
  assert.ok(routes.has(UPDATE_PATH), `missing ${UPDATE_PATH}; have ${[...routes.keys()].join(', ')}`)
})

test('a same-origin call with the key reaches the check and reports the result', async () => {
  const app = mount()
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler(request({
    origin: `http://${HOST}`,
    'sec-fetch-site': 'same-origin',
    'x-plugin-health-key': KEY,
  }), res)
  assert.equal(captured.status, 200)
  assert.equal(captured.body.latestVersion, '2.0.1')
  assert.equal(captured.body.updateAvailable, true)
  assert.match(captured.body.upgradeHint, /dsh-plugin-health@2\.0\.1$/u)
  assert.equal(app.calls(), 1)
})

test('a cross-origin page cannot trigger a check', async () => {
  const app = mount()
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler(request({ origin: 'http://127.0.0.1:3000', 'x-plugin-health-key': KEY }), res)
  assert.equal(captured.status, 403)
  assert.equal(app.calls(), 0, 'nothing may reach the registry for a cross-site caller')
})

test('a text/plain body is refused, because it would skip the preflight', async () => {
  const app = mount()
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler(request({ 'content-type': 'text/plain', 'x-plugin-health-key': KEY }), res)
  assert.equal(captured.status, 415)
  assert.equal(app.calls(), 0)
})

test('the control key is required', async () => {
  const app = mount()
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler(request({ origin: `http://${HOST}` }), res)
  assert.equal(captured.status, 401)
  assert.equal(app.calls(), 0)
})

test('a non-loopback host is refused outright', async () => {
  const app = mount()
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler(request({ host: 'evil.example:5140', origin: 'http://evil.example:5140', 'x-plugin-health-key': KEY }), res)
  assert.equal(captured.status, 403)
  assert.equal(app.calls(), 0)
})

test('the route is POST-only', async () => {
  const app = mount({})
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler({ ...request({ 'x-plugin-health-key': KEY }), method: 'GET' }, res)
  assert.equal(captured.status, 405)
})

test('a check that blows up reports an error instead of hanging the panel', async () => {
  const app = mount({ refreshUpdateImpl: async () => { throw new Error('registry exploded') } })
  const handler = app.routes.get(UPDATE_PATH)
  const { captured, res } = recorder()
  await handler(request({ origin: `http://${HOST}`, 'x-plugin-health-key': KEY }), res)
  assert.equal(captured.status, 500)
  assert.match(captured.body.error, /registry exploded/u)
})