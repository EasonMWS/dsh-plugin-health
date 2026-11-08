/**
 * The outside half: a local server that runs when DSH is not.
 *
 * What it is for, and what it deliberately is not:
 *
 *   is  — check whether a profile is safe to start, take snapshots, and get DSH running again when
 *         it will not. None of those need the host.
 *   is not — diagnose a running DSH, rehearse a plugin, or write a version exemption. Those need the
 *         host: rehearsing means starting a loader, and an exemption is scoped to the exact running
 *         version. Duplicating them here would create a second safety model that drifts from the
 *         first.
 *
 * The two halves share one state file (src/state/shared.js). This server watches it, so when the
 * panel inside DSH writes something, a page open here updates without a refresh, and the reverse.
 * @module outside/server
 */

import { createServer } from 'node:http'

import { admissionReport } from './admission.js'
import { readState, updateState } from '../state/shared.js'
import { watchStateWithFallback } from '../state/sync.js'

/** Loopback only: this changes profile state and must not be reachable from the network. */
const HOST = '127.0.0.1'

/**
 * Refuse anything that did not come from this page.
 *
 * The in-DSH panel uses a per-launch control key because its routes are reachable by any local
 * process. Here the same risk exists, so the same rule applies: writes need a key that only the served
 * page has, and the Origin has to match.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} key
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function authorizeWrite(req, key) {
  const origin = req.headers.origin
  const host = req.headers.host ?? ''
  if (typeof origin === 'string' && origin !== '' && origin !== `http://${host}`) {
    return { ok: false, status: 403, error: 'origin does not match' }
  }
  if (req.headers['x-health-key'] !== key) return { ok: false, status: 401, error: 'missing or invalid key' }
  return { ok: true }
}

/**
 * Read a JSON body with a size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 */
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('body is not JSON')) }
    })
    req.on('error', reject)
  })
}

/** Send JSON, no caching. */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Start the outside server.
 *
 * @param {{
 *   home: string,
 *   profile: string,
 *   key: string,
 *   key2?: string,
 *   runtimeVersion?: string|(() => string|undefined),
 *   pollMs?: number,
 * }} options
 * @returns {Promise<{url: string, key: string, close: () => Promise<void>, mode: () => string}>}
 */
export async function startOutsideServer({ home, profile, key, runtimeVersion, pollMs = 2_000 }) {
  /** Every open SSE response, so a state change can be pushed to all of them. */
  const listeners = new Set()

  const watcher = watchStateWithFallback(home, {
    onChange: (info) => {
      const payload = `data: ${JSON.stringify(info)}\n\n`
      for (const res of listeners) {
        try { res.write(payload) } catch { listeners.delete(res) }
      }
    },
    pollMs,
  })

  const resolveRuntime = () => (typeof runtimeVersion === 'function' ? runtimeVersion() : runtimeVersion)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`)

    // --- events: push state changes rather than making the page poll ---
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ hello: true, rev: readState(home).state.rev })}\n\n`)
      listeners.add(res)
      req.on('close', () => listeners.delete(res))
      return
    }

    // --- read: current state plus an admission report, both cheap enough to recompute ---
    if (url.pathname === '/state' && req.method === 'GET') {
      const { state, problem } = readState(home)
      send(res, 200, {
        schemaVersion: 1,
        profile,
        home,
        state,
        problem: problem ?? null,
        watchMode: watcher.mode,
      })
      return
    }

    if (url.pathname === '/admission' && req.method === 'GET') {
      const target = url.searchParams.get('target') ?? undefined
      try {
        const report = admissionReport({
          home, profile, runtimeVersion: resolveRuntime(), targetVersion: target,
        })
        send(res, 200, report)
      } catch (error) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // --- write: record an admission result so the panel inside DSH can recognise it ---
    if (url.pathname === '/admission' && req.method === 'POST') {
      const allowed = authorizeWrite(req, key)
      if (allowed.ok !== true) { send(res, allowed.status, { error: allowed.error }); return }
      readJsonBody(req).then((body) => {
        const result = updateState(home, (current) => ({ ...current, admission: body?.admission ?? null }), { writer: 'outside' })
        if (result.ok !== true) { send(res, 500, { error: result.error }); return }
        send(res, 200, { ok: true, rev: result.state.rev })
      }).catch((error) => send(res, 400, { error: String(error.message ?? error) }))
      return
    }

    // --- intent: ask the panel inside DSH to do something only it can do ---
    if (url.pathname === '/intent' && req.method === 'POST') {
      const allowed = authorizeWrite(req, key)
      if (allowed.ok !== true) { send(res, allowed.status, { error: allowed.error }); return }
      readJsonBody(req).then((body) => {
        const op = typeof body?.op === 'string' ? body.op : ''
        if (op === '') { send(res, 400, { error: 'op is required' }); return }
        const intent = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          op,
          args: body?.args ?? {},
          requestedBy: 'outside',
          at: new Date().toISOString(),
        }
        const result = updateState(home, (current) => ({ ...current, pendingIntent: intent }), { writer: 'outside' })
        if (result.ok !== true) { send(res, 500, { error: result.error }); return }
        send(res, 200, { ok: true, intent, rev: result.state.rev })
      }).catch((error) => send(res, 400, { error: String(error.message ?? error) }))
      return
    }

    if (url.pathname === '/intent' && req.method === 'DELETE') {
      const allowed = authorizeWrite(req, key)
      if (allowed.ok !== true) { send(res, allowed.status, { error: allowed.error }); return }
      const result = updateState(home, (current) => ({ ...current, pendingIntent: null }), { writer: 'outside' })
      if (result.ok !== true) { send(res, 500, { error: result.error }); return }
      send(res, 200, { ok: true, rev: result.state.rev })
      return
    }

    send(res, 404, { error: 'not found' })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, resolve)
  })

  const port = server.address().port
  return {
    url: `http://${HOST}:${port}`,
    key,
    mode: () => watcher.mode,
    async close() {
      for (const res of listeners) { try { res.end() } catch { /* gone */ } }
      listeners.clear()
      watcher.close()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
