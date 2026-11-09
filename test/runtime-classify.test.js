import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyFailure, FAILURE_KINDS } from '../src/runtime/classify.js'
import { runRuntimeSmoke } from '../src/runtime/smoke.js'

const FIXTURES = new URL('./fixtures/smoke-failures/', import.meta.url)
const load = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))
const constructed = load('constructed.json').samples

test('real samples from dsh 0.2.2-rc.1 are classified by the stage that failed', () => {
  assert.deepEqual(
    { stage: classifyFailure(load('gate-rejected.json')).stage, kind: classifyFailure(load('gate-rejected.json')).kind },
    { stage: 'install', kind: 'gate-rejected' },
  )
  assert.equal(classifyFailure(load('not-found.json')).kind, 'not-found')
  const waiting = classifyFailure(load('missing-service.json'))
  assert.equal(waiting.kind, 'missing-service', 'the waiting is the useful part, not "did not activate"')
  assert.equal(waiting.stage, 'runtime')
  assert.match(waiting.detail, /waiting for/u)
})

test('a passing stage is not read: a retried network blip during install does not explain a boot failure', () => {
  const report = load('missing-service.json')
  const install = report.stages.find((stage) => stage.name === 'install')
  install.stdout = ` WARN  GET https://registry.npmjs.org/dsh-prime-memory error (ECONNRESET). Will retry in 10 seconds. 2 retries left.\n${install.stdout}`
  assert.equal(install.ok, true, 'the install itself succeeded after the retry')
  assert.equal(classifyFailure(report).kind, 'missing-service')
})

for (const sample of constructed) {
  test(`constructed sample: ${sample.kind} (${sample.source})`, () => {
    const failure = classifyFailure({ ok: false, stages: sample.stages })
    assert.equal(failure.kind, sample.kind)
    assert.equal(typeof failure.detail, 'string')
  })
}

test('every kind the classifier can return has at least one sample', () => {
  const covered = new Set([
    ...constructed.map((sample) => sample.kind),
    ...['gate-rejected.json', 'not-found.json', 'missing-service.json'].map((name) => classifyFailure(load(name)).kind),
  ])
  assert.deepEqual(FAILURE_KINDS.filter((kind) => !covered.has(kind)), [])
})

test('a passing report has no failure, and an orchestrator error before any stage is still classified', () => {
  assert.equal(classifyFailure({ ok: true, stages: [] }), null)
  assert.deepEqual(classifyFailure({ ok: false, stages: [], error: 'getaddrinfo ENOTFOUND registry.npmjs.org' }),
    { stage: 'setup', kind: 'network', detail: 'getaddrinfo ENOTFOUND registry.npmjs.org' })
  assert.equal(classifyFailure({ ok: false, stages: [], error: 'boom' }).kind, 'unknown')
})

test('smoke appends failure only to a failed report', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-classify-'))
  const host = join(directory, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', bin: { dsh: 'lib/bin.js' } }))
  const options = { dshDirectory: host, plugin: 'p@1.0.0', bootOnly: true, out: directory }
  const rejected = await runRuntimeSmoke(options, {
    probePnpm: async () => null,
    runProcess: async () => ({ ok: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'dsh: installation rejected: Plugin p@1.0.0 is incompatible with dsh 0.2.2-rc.1' }),
  })
  assert.equal(rejected.failure.kind, 'gate-rejected')
  assert.equal(JSON.parse(readFileSync(join(rejected.directory, 'smoke.json'), 'utf8')).failure.kind, 'gate-rejected', 'the saved report has it too')

  const passed = await runRuntimeSmoke(options, {
    probePnpm: async () => null,
    runProcess: async (args) => {
      if (!args.includes('add')) writeFileSync(JSON.parse(readFileSync(args.at(-1), 'utf8')).resultPath, JSON.stringify({ ok: true }))
      return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' }
    },
  })
  assert.equal(passed.ok, true)
  assert.equal(Object.hasOwn(passed, 'failure'), false)
})
