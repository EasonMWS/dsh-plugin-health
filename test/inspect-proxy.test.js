// Regression tests for issue #7: the `proxy-env` finding was a false positive on every host this tool
// supports, and its suggested remedy could stop the DSH desktop app from starting.
//
// Two things are pinned here:
//   1. the finding is gone, and the environment scan still produces its other findings (so the absence of
//      `proxy-env` means "correctly not reported", not "the whole function stopped running");
//   2. no user-facing copy tells anyone to set NODE_USE_ENV_PROXY, because that instruction is the dangerous
//      part — a scheme-less proxy value plus that flag makes Node exit before any JavaScript runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectDshHome } from '../src/repair/inspect.js'

/** A home just real enough for the environment scan to run against. */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-health-proxy-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: [] } },
  }))
  return { home }
}

/** Run the scan with the given environment, restoring the caller's environment afterwards. */
function scanWith(env, { home }) {
  const saved = {}
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'NODE_USE_ENV_PROXY']) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  Object.assign(process.env, env)
  try {
    return inspectDshHome({ home, profile: 'web', runtimeVersion: '0.2.2-rc.1' })
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const ids = (result) => (result.findings ?? []).map((entry) => entry.id)

test('a configured proxy without NODE_USE_ENV_PROXY is the healthy state, not a finding', () => {
  // This is the exact tuple every current desktop install has: dsh-http-proxy writes the policy into the
  // host environment and installs an undici dispatcher, and only gives NODE_USE_ENV_PROXY to child processes.
  for (const env of [
    { HTTPS_PROXY: 'http://127.0.0.1:6074' },
    { HTTPS_PROXY: 'http://127.0.0.1:6074', HTTP_PROXY: 'http://127.0.0.1:6074' },
    { HTTPS_PROXY: '127.0.0.1:6074' },
    { ALL_PROXY: 'socks5://127.0.0.1:1080' },
    { HTTPS_PROXY: 'http://127.0.0.1:6074', NODE_USE_ENV_PROXY: '1' },
  ]) {
    const result = scanWith(env, fixtureHome())
    assert.ok(!ids(result).includes('proxy-env'), `reported proxy-env for ${JSON.stringify(env)}`)
    // Nothing may mention the flag either: the warning text alone was enough to lead people to set it.
    for (const entry of result.findings ?? []) {
      assert.doesNotMatch(JSON.stringify(entry), /NODE_USE_ENV_PROXY/u, `a finding still mentions the flag: ${entry.id}`)
    }
  }
})

test('the environment scan still reports its other findings', () => {
  // Without this, the test above would also pass if inspectEnvironment had been deleted outright.
  const { home } = fixtureHome()
  writeFileSync(join(home, '.npmrc'), 'registry=https://registry.npmmirror.com\n')
  const result = scanWith({ HTTPS_PROXY: 'http://127.0.0.1:6074' }, { home })
  assert.ok(ids(result).includes('registry-mirror'), 'the environment scan stopped producing findings')
  assert.ok(!ids(result).includes('proxy-env'))
})

test('no user-facing copy tells anyone to set NODE_USE_ENV_PROXY', () => {
  // The instruction is the hazardous part of the old check, so it must not survive in any wording.
  const client = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /NODE_USE_ENV_PROXY/u, 'user-facing copy still mentions the flag')

  // And the finding id must not come back without someone also restoring the reasoning in inspect.js.
  const inspect = readFileSync(new URL('../src/repair/inspect.js', import.meta.url), 'utf8')
  assert.doesNotMatch(inspect, /finding\('proxy-env'/u, 'the proxy-env finding was re-added')
  assert.match(inspect, /installProxyFromEnvironment/u, 'the explanation of why it was removed is missing')
})