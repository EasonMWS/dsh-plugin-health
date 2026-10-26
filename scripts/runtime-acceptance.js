/** Network-enabled acceptance; requires an installed official DSH host and pnpm on PATH. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runRuntimeSmoke } from '../src/runtime/smoke.js'

const dshDirectory = process.argv[2]
assert.ok(dshDirectory, 'usage: npm run test:runtime -- /path/to/node_modules/@deepseek-ai/dsh')
assert.ok(process.env.npm_execpath, 'run via npm run test:runtime')
const directory = mkdtempSync(join(tmpdir(), 'dsh-health-host-acceptance-'))
const sources = {
  healthy: `import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'health_fixture', parameters: {},
    output: { schema: { type: 'integer' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async () => 42,
  }))
}
`,
  pending: `export const inject = ['healthFixtureMissingService']
export function apply() {}
`,
  throwing: `export function apply() { throw new Error('health fixture activation rejected') }
`,
  hanging: `export async function apply(ctx) {
  const timer = setInterval(() => {}, 1000)
  ctx.on('dispose', () => { clearInterval(timer) })
  await new Promise(() => {})
}
`,
}

const results = []
for (const [kind, source] of Object.entries(sources)) {
  const fixture = join(directory, kind)
  mkdirSync(fixture)
  const name = `dsh-health-fixture-${kind}`
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    engines: { dsh: '>=0.2.1-rc.2 <0.2.2-0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.1-rc.2 <0.2.2-0' },
    peerDependenciesMeta: { '@deepseek-ai/dsh-tools': { optional: true } },
  }))
  writeFileSync(join(fixture, 'index.js'), source)
  writeFileSync(join(fixture, 'cordis.patch.yml'), `- insert:\n    - id: ${kind}\n      name: ${name}\n`)
  const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts'], {
    cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }))
  const report = await runRuntimeSmoke({
    dshDirectory: resolve(dshDirectory), plugin: join(fixture, packed[0].filename), out: directory,
    tools: ['health_fixture'],
    calls: kind === 'healthy' ? [{ name: 'health_fixture', arguments: {}, expectedValue: 42 }] : [],
    timeoutMs: kind === 'hanging' ? 2000 : 30000,
  })
  assert.equal(report.stages[0]?.ok, true, JSON.stringify(report))
  const runtime = report.stages[1]
  if (kind === 'healthy') {
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.deepEqual(runtime.details.assertions.executed, [{ name: 'health_fixture', ok: true }])
  } else {
    assert.equal(report.ok, false, JSON.stringify(report))
    assert.equal(runtime.details?.stage, 'boot', JSON.stringify(report))
    if (kind === 'hanging') assert.equal(runtime.timedOut, true, JSON.stringify(report))
    else assert.match(`${runtime.details.error}\n${runtime.stderr}`, new RegExp(name))
  }
  results.push({ kind, expectedOutcome: kind === 'healthy' ? 'pass' : 'fail', report: join(report.directory, 'smoke.json') })
}
console.log(JSON.stringify({ ok: true, directory, results }, null, 2))
