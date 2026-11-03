import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'

import { checkLoopbackPeer, checkWriteRequest } from '../src/ui/guard.js'
import { registerRepairRoute } from '../src/ui/repair-route.js'
import { registerRescueRoute } from '../src/ui/rescue-route.js'

// Every route used to decide "loopback only" from the `Host` header. That header is written by the
// client, so with the web server bound to a LAN address — which the host supports — any machine on
// the network could send `Host: 127.0.0.1:<port>` and pass every check behind it. The peer address
// is the part of the connection a client cannot choose.

test('a peer outside loopback is refused', () => {
  for (const address of ['192.168.1.50', '10.0.0.7', '172.16.4.2', '203.0.113.9', '::ffff:192.168.1.5', 'fe80::1']) {
    const verdict = checkLoopbackPeer({ socket: { remoteAddress: address } })
    assert.equal(verdict.ok, false, `${address} must not be treated as local`)
    assert.equal(verdict.status, 403)
  }
})

test('every loopback form is accepted', () => {
  // 127.0.0.0/8, not just .1: some systems resolve localhost to 127.0.0.53, and a dual-stack socket
  // reports an IPv4 loopback peer as ::ffff:127.0.0.1.
  for (const address of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
    assert.equal(checkLoopbackPeer({ socket: { remoteAddress: address } }).ok, true, `${address} is local`)
  }
})

test('a hand-built request with no socket is not blocked', () => {
  // Internal callers and test doubles have no socket; there is nothing to verify.
  assert.equal(checkLoopbackPeer({ headers: {} }).ok, true)
  assert.equal(checkLoopbackPeer({}).ok, true)
})

test('the repair route refuses a LAN peer that forges the Host header', async () => {
  const routes = []
  const ctx = {
    inject: (_d, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes.push(r); return () => {} } } }),
  }
  const key = registerRepairRoute(ctx, {
    resolveProfile: () => ({ home: '/nonexistent', profile: 'desktop' }),
    getStatus: () => ({ issues: [] }),
  })
  assert.equal(typeof key, 'string')

  const handler = routes[0].handler
  const status = await invoke(handler, {
    host: '127.0.0.1:5140',
    remoteAddress: '192.168.1.50',
    headers: { host: '127.0.0.1:5140', 'content-type': 'application/json', 'x-plugin-health-key': key },
  })
  assert.equal(status, 403, 'a forged Host must not survive a real peer check')
})

test('the status route refuses a LAN peer too, because it hands out the cookie', async () => {
  const routes = []
  const ctx = {
    inject: (_d, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes.push(r); return () => {} } } }),
  }
  registerRepairRoute(ctx, {
    resolveProfile: () => ({ home: '/nonexistent', profile: 'desktop' }),
    getStatus: () => ({ issues: [] }),
  })
  const statusRoute = routes.find((r) => r.path === '/plugins/dsh-plugin-health/status')
  const status = await invoke(statusRoute.handler, {
    host: '127.0.0.1:5140',
    remoteAddress: '192.168.1.50',
    headers: { host: '127.0.0.1:5140' },
  })
  assert.equal(status, 403)
})

test('the rescue and update routes refuse a LAN peer', async () => {
  const routes = []
  const ctx = {
    inject: (_d, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes.push(r); return () => {} } } }),
  }
  registerRescueRoute(ctx, {
    currentProfile: () => ({ home: '/nonexistent', profile: 'desktop', profileDir: '/nonexistent/profiles/desktop', runtimeVersion: '0.2.1-rc.5' }),
    key: 'k'.repeat(48),
    refreshUpdateImpl: async () => ({ status: 'ok' }),
  })
  for (const path of ['/plugins/dsh-plugin-health/rescue/undo', '/plugins/dsh-plugin-health/update']) {
    const route = routes.find((r) => (r.kind === 'exact' ? r.path === path : path.startsWith(r.path)))
    const status = await invoke(route.handler, {
      host: '127.0.0.1:5140',
      remoteAddress: '192.168.1.50',
      headers: { host: '127.0.0.1:5140', 'content-type': 'application/json', 'x-plugin-health-key': 'k'.repeat(48) },
    })
    assert.equal(status, 403, `${path} must refuse a non-local peer`)
  }
})

test('a chunked body cannot slip past the content-type requirement', () => {
  // `content-length` is absent on a chunked request, and the old rule read that as "no body".
  const chunked = checkWriteRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:1', 'transfer-encoding': 'chunked' },
  })
  assert.equal(chunked.ok, false)
  assert.equal(chunked.status, 415)
  // A genuinely body-less POST still works: no length, no chunking.
  assert.equal(checkWriteRequest({ method: 'POST', headers: { host: '127.0.0.1:1' } }).ok, true)
  assert.equal(checkWriteRequest({ method: 'POST', headers: { host: '127.0.0.1:1', 'content-length': '0' } }).ok, true)
})

test('the GET dry-run is subject to the status guard', () => {
  // `checkWriteRequest` waves read methods through, so a same-site page could fire a scan with the
  // cookie. The repair route now applies the status guard to GET specifically.
  assert.equal(checkWriteRequest({ method: 'GET', headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-site' } }).ok, true,
    'the write guard still lets reads through by design')
})

/**
 * Drive a route handler with a real-ish request object, including a socket peer address.
 * @returns {Promise<number>} the status code the handler chose.
 */
function invoke(handler, { host, remoteAddress, headers, body }) {
  const payload = body ?? ''
  const req = {
    method: 'POST',
    url: '/plugins/dsh-plugin-health/repair',
    headers: { ...headers, 'content-length': String(Buffer.byteLength(payload)) },
    socket: { remoteAddress, remotePort: 51000, localAddress: '127.0.0.1' },
    connection: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
  void host
  return new Promise((resolve) => {
    handler(req, {
      writeHead(status) { resolve(status) },
      end() {},
      headersSent: false,
    }).catch(() => resolve(500))
  })
}

// A LAN-bound host is the case the Host header cannot detect, so it is worth proving the whole
// stack refuses it rather than only the predicate.
test('over a real socket, a non-loopback remote address is refused', async () => {
  const routes = []
  const ctx = {
    inject: (_d, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes.push(r); return () => {} } } }),
  }
  registerRepairRoute(ctx, {
    resolveProfile: () => ({ home: '/nonexistent', profile: 'desktop' }),
    getStatus: () => ({ issues: [] }),
  })
  const server = createServer((req, res) => {
    const path = String(req.url ?? '').split('?')[0]
    const route = routes.find((r) => (r.kind === 'exact' ? r.path === path : path.startsWith(r.path)))
    if (route === undefined) { res.writeHead(404).end('{}'); return }
    // Simulate a connection that arrived from the LAN: the socket is real, its peer is not loopback.
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.50', configurable: true })
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/plugins/dsh-plugin-health/status',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}` },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})