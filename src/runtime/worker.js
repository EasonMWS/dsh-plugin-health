/** Child process: isolate host global state and enforce timeout from the parent. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Cordis const-enum ACTIVE is 2 in the supported rc.2/rc.3 host lines. */
export function verifyActivation(ctx) {
  const loader = ctx.get('loader')
  assert.ok(loader, 'profile exited before runtime acceptance')
  const inactive = []
  for (const entry of loader.entries()) {
    if (entry.disabled || entry.fiber?.state === 2) continue
    const fiber = entry.fiber
    const missing = fiber === undefined ? [] : Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    inactive.push(`${entry.options.id ?? '?'} (${entry.options.name}): ${fiber === undefined ? 'not loaded' : `fiber state ${fiber.state}`}${missing.length ? `, waiting for ${missing.join(', ')}` : ''}`)
  }
  assert.equal(inactive.length, 0, `profile entries did not activate:\n${inactive.join('\n')}`)
}

/** Registration alone does not prove execution; callers can supply real tool calls too. */
export async function verifyTools(ctx, tools, calls) {
  const runtime = ctx.get('tools')
  const registered = []
  for (const name of new Set([...tools, ...calls.map(call => call.name)])) {
    assert.ok(runtime?.get(name), `tool did not register: ${name}`)
    registered.push(name)
  }
  const executed = []
  for (const [index, call] of calls.entries()) {
    const result = await runtime.execute({
      callId: `health-smoke-${index}`, name: call.name, arguments: call.arguments,
      signal: new AbortController().signal,
    })
    assert.notEqual(result.isError, true, `tool returned an error: ${call.name}: ${JSON.stringify(result)}`)
    if (Object.hasOwn(call, 'expectedValue')) assert.deepEqual(result.value, call.expectedValue, `unexpected value from ${call.name}`)
    executed.push({ name: call.name, ok: true })
  }
  return { registered, executed }
}

/**
 * Without tool assertions the run is boot-only: activation is the whole claim, so
 * record what actually activated instead of returning an empty, uninformative report.
 */
export function describeActivation(ctx) {
  const loader = ctx.get('loader')
  const entries = []
  for (const entry of loader?.entries?.() ?? []) {
    if (entry.disabled) continue
    entries.push({ id: entry.options.id ?? null, name: entry.options.name ?? null, state: entry.fiber?.state ?? null })
  }
  return { bootOnly: true, activeEntries: entries }
}

async function main(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const report = { ok: false, stage: 'boot' }
  const save = () => { writeFileSync(config.resultPath, `${JSON.stringify(report, null, 2)}\n`) }
  let ctx
  let shutdown
  let code = 1
  save()
  try {
    const requireHost = createRequire(join(config.hostDir, 'package.json'))
    const { runProfile } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh/profile-boot')).href)
    const { loadLayeredEnv } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-app-boot')).href)
    ;({ ctx, shutdown } = await runProfile({
      environment: loadLayeredEnv('dsh-health-smoke'), profile: config.profile, patchFiles: [], args: [],
    }))
    // Some hosts only warn about pending entries; do not turn that into a green smoke result.
    verifyActivation(ctx)
    report.stage = 'assertions'
    save()
    report.assertions = config.tools.length === 0 && config.calls.length === 0
      ? describeActivation(ctx)
      : await verifyTools(ctx, config.tools, config.calls)
    report.stage = 'shutdown'
    save()
    code = 0
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    // Persist only after actual disposal. A stuck disposer remains a timeout failure.
    try {
      if (ctx !== undefined) await ctx.fiber.dispose()
    } catch (error) {
      code = 1
      report.error = `shutdown failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    }
    save()
    // A forced zero exit during shutdown must leave ok=false in the report.
    // The launcher's ordinary shutdown sets exitCode and resolves after proxy cleanup.
    if (shutdown !== undefined) await shutdown.shutdown(code)
    report.ok = code === 0
    if (report.ok) report.stage = 'complete'
    save()
    if (shutdown === undefined) process.exit(code)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
