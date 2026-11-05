import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../src/plugin.js'

// Every previous route test built its own `currentProfile` and handed it straight to
// `createRescueHandlers`. That is convenient and it hid a real defect: `plugin.js` supplies
// `currentProfile` from the host's `profileContext`, which carries only `home` and `profile` — no
// `profileDir` — and the update action read `profileDir` off it. The result was that "install
// update" answered 400 in any real host, while every test passed.
//
// So this test goes through the real entry point: `plugin.apply(ctx)` with a `ctx` shaped like the
// host's, the registered handlers mounted on a real server, and a real request.

/** A ctx shaped like the host's: `profileContext` with dir and name, and a webServer that records. */
function hostContext(home, profileName) {
  const routes = []
  const profileDir = join(home, 'profiles', profileName)
  const ctx = {
    get: (name) => (name === 'profileContext' ? { dir: profileDir, name: profileName } : undefined),
    inject: (_deps, fn) => fn({
      effect: (f) => f(),
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
    }),
  }
  return { ctx, routes, profileDir }
}

/** Mount the routes the plugin registered and drive one request through them. */
async function mountAndCall(routes, path, { method = 'GET', headers = {}, body } = {}) {
  const server = createServer((req, res) => {
    const url = String(req.url ?? '').split('?')[0]
    const route = routes.find((candidate) => (candidate.kind === 'exact' ? candidate.path === url : url.startsWith(candidate.path)))
    if (route === undefined) { res.writeHead(404).end('{}'); return }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { host: `127.0.0.1:${port}`, ...headers },
      body,
    })
    let parsed
    try { parsed = await response.json() } catch { parsed = undefined }
    return { status: response.status, body: parsed }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the install action receives a profile directory from the real host context', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wiring-'))
  const previous = process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
  process.env.DSH_PLUGIN_HEALTH_NO_UPDATE = '1'
  try {
    const { ctx, routes, profileDir } = hostContext(home, 'desktop')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-plugin-health'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', private: true }))
    // Install the version already on disk: the downgrade guard must not interfere, and the point is
    // not the install outcome anyway — it is that the request reaches installUpdate with a real
    // directory instead of failing on `undefined`.
    const INSTALLED = '3.0.0'
    writeFileSync(join(profileDir, 'node_modules', 'dsh-plugin-health', 'package.json'),
      JSON.stringify({ name: 'dsh-plugin-health', version: INSTALLED }))

    await plugin.apply(ctx)

    // The status route hands out the key the write routes need.
    const status = await mountAndCall(routes, '/plugins/dsh-plugin-health/status')
    assert.equal(status.status, 200)
    const key = status.body?.key
    assert.equal(typeof key, 'string', 'the status snapshot must carry the key')

    const install = await mountAndCall(routes, '/plugins/dsh-plugin-health/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-health-key': key },
      body: JSON.stringify({ action: 'install', version: INSTALLED }),
    })

    // The assertion is about wiring, not about the install succeeding: a real host may have no
    // package manager, no network, or no such version published. What must not happen is the request
    // dying before it knows where the profile is — which is exactly what B1 did.
    const error = String(install.body?.error ?? '')
    assert.doesNotMatch(error, /no profile to install into/u,
      `the profile directory never arrived: ${JSON.stringify(install.body)}`)
    // Reaching the package manager at all proves the directory was resolved and used.
    const reachedManager = install.body?.startedAt !== null && install.body?.startedAt !== undefined
    assert.ok(reachedManager || install.phase === 'done',
      `the request never reached the installer: ${JSON.stringify(install.body)}`)
  } finally {
    if (previous === undefined) delete process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
    else process.env.DSH_PLUGIN_HEALTH_NO_UPDATE = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('the status route works when the host supplies only dir and name', async () => {
  // `runningProfile()` derives home by stripping `/profiles/<name>` off `profileContext.dir`. If that
  // derivation ever breaks, every route loses its context at once — so it is asserted directly.
  const home = mkdtempSync(join(tmpdir(), 'wiring-status-'))
  const previous = process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
  process.env.DSH_PLUGIN_HEALTH_NO_UPDATE = '1'
  try {
    const { ctx, routes, profileDir } = hostContext(home, 'desktop')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', private: true }))

    await plugin.apply(ctx)
    const status = await mountAndCall(routes, '/plugins/dsh-plugin-health/status')
    assert.equal(status.status, 200)
    assert.equal(status.body?.profile, 'desktop')
    assert.equal(status.body?.home, home, 'home must be derived from the profile directory')
    assert.equal(status.body?.profileDir, profileDir)
  } finally {
    if (previous === undefined) delete process.env.DSH_PLUGIN_HEALTH_NO_UPDATE
    else process.env.DSH_PLUGIN_HEALTH_NO_UPDATE = previous
    rmSync(home, { recursive: true, force: true })
  }
})
