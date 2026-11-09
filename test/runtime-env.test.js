import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanEnvironment, environmentForRun } from '../src/runtime/env.js'

// `smoke` used to hand the plugin under test `{ ...process.env }`. Rehearsing your own plugin with your own
// environment is one thing; batch-running plugins you have never read is another, and CI environments are full
// of tokens. These tests pin what crosses the boundary.

/** A source environment shaped like CI: identity, machine basics, tokens, and proxies. */
const SOURCE = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/runner',
  LANG: 'C.UTF-8',
  CI: 'true',
  TZ: 'UTC',
  // Credentials that must never reach a third-party plugin.
  GITHUB_TOKEN: 'ghs_do_not_leak',
  NPM_TOKEN: 'npm_do_not_leak',
  FAKE_API_TOKEN: 'sk_do_not_leak',
  AWS_SECRET_ACCESS_KEY: 'do_not_leak',
  MY_PASSWORD: 'do_not_leak',
  NODE_AUTH_TOKEN: 'do_not_leak',
  ACTIONS_RUNTIME_TOKEN: 'do_not_leak',
  RUNNER_TEMP: '/tmp/runner',
  GITHUB_WORKSPACE: '/workspace',
  // Needed to install anything at all.
  HTTPS_PROXY: 'http://127.0.0.1:3128',
  npm_config_registry: 'https://registry.npmjs.org',
  // Noise that is neither needed nor secret.
  SOME_UNRELATED_VARIABLE: 'x',
}

test('cleaned, only the machine basics and the package-manager plumbing survive', () => {
  const { env } = cleanEnvironment(SOURCE, { home: '/tmp/home' })

  assert.equal(env.PATH, '/usr/local/bin:/usr/bin')
  assert.equal(env.HOME, '/home/runner')
  assert.equal(env.LANG, 'C.UTF-8')
  assert.equal(env.CI, 'true')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128')
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org')
  assert.equal(env.DSH_HOME, '/tmp/home', 'the run must be pointed at the throwaway home')
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1')

  assert.equal(env.SOME_UNRELATED_VARIABLE, undefined, 'anything not on the list is dropped')
})

test('no credential survives, whatever it is called', () => {
  // The list is an allowlist, so this is a second lock rather than the only one: one careless addition to the
  // allowlist must not be enough to hand out a token.
  const { env } = cleanEnvironment(SOURCE, { home: '/tmp/home' })
  for (const name of ['GITHUB_TOKEN', 'NPM_TOKEN', 'FAKE_API_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_PASSWORD',
    'NODE_AUTH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TEMP', 'GITHUB_WORKSPACE']) {
    assert.equal(env[name], undefined, `${name} must not reach the plugin under test`)
  }
})

test('the credential rule beats the allowlist', () => {
  // `path` is allowed. `PRIVATE_PATH`-style names are not, and a name that looks like a secret is refused even
  // when its lowercased form would match an allowed entry.
  const { env } = cleanEnvironment({ PRIVATE_KEY_PAIR: 'x', PATH: '/bin' }, { home: '/tmp/h' })
  assert.equal(env.PRIVATE_KEY_PAIR, undefined)
  assert.equal(env.PATH, '/bin')
})

test('Windows names match case-insensitively', () => {
  // Windows spells some of these `Path`, `SystemRoot`, `windir`. A case-sensitive allowlist would strip the
  // environment so far that the host could not start.
  const { env } = cleanEnvironment({
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\runner',
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE',
    PROCESSOR_ARCHITECTURE: 'AMD64',
  }, { home: 'C:\\tmp' })

  for (const name of ['Path', 'USERPROFILE', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE']) {
    assert.ok(env[name] !== undefined, `${name} must survive on Windows`)
  }
})

test('the report lists names only, never values', () => {
  // A report is meant to be shared. A value here would be the token in the gist.
  const { passed } = cleanEnvironment(SOURCE, { home: '/tmp/home' })
  assert.ok(Array.isArray(passed))
  assert.ok(passed.includes('PATH'))
  assert.ok(passed.includes('DSH_HOME'))
  for (const name of passed) {
    assert.equal(typeof name, 'string')
    assert.doesNotMatch(name, /=|:\/\//u, 'the list must contain names, not assignments or URLs')
  }
  assert.equal(passed.includes('GITHUB_TOKEN'), false)
})

test('without the flag nothing changes, and the report says so', () => {
  // The documented behaviour for rehearsing your own plugin. Changing it silently would be worse than the
  // original exposure.
  const { env, report } = environmentForRun({ clean: false, source: SOURCE, home: '/tmp/home' })
  assert.equal(env.GITHUB_TOKEN, 'ghs_do_not_leak', 'inherited mode is unchanged, by design')
  assert.equal(env.DSH_HOME, '/tmp/home')
  assert.deepEqual(report, { mode: 'inherited', passed: [] })
})

test('with the flag the report says clean and names what was passed', () => {
  const { env, report } = environmentForRun({ clean: true, source: SOURCE, home: '/tmp/home' })
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(report.mode, 'clean')
  assert.ok(report.passed.includes('PATH'))
})

test('a non-string value is skipped rather than coerced', () => {
  const { env } = cleanEnvironment({ PATH: '/bin', WEIRD: undefined }, { home: '/tmp/h' })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.WEIRD, undefined)
})