/** Child process: isolate host global state and enforce timeout from the parent. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The value cordis uses to mean "this fiber is running".
 *
 * `@deepseek-ai/cordis@4.1.0` declares `FiberState` as a `const enum` in `lib/types/fiber.d.ts` with
 * `ACTIVE = 2`. A `const enum` is erased at compile time, so there is nothing to import from the host at
 * runtime — this number has to be a constant here. `checkHostContract` below is what notices if it changes.
 */
export const FIBER_ACTIVE = 2

/**
 * Check that the host still agrees with `FIBER_ACTIVE`, before blaming the plugin under test.
 *
 * If the host changes its state enum, every entry reports a value this module does not recognise, and the
 * activation assertions would fail with "did not activate" — which points the reader at their plugin instead
 * of at this tool. The official entries are the control group: they are always present and always running,
 * so if none of them match, the constant is what is wrong.
 *
 * @param {object} ctx - host context from `runProfile`.
 * @param {{fiberActive?: number}} [options]
 * @throws {Error} whose message starts with `host-contract-changed:` when no official entry is active.
 */
export function checkHostContract(ctx, { fiberActive = FIBER_ACTIVE } = {}) {
  const loader = ctx.get('loader')
  const official = [...(loader?.entries?.() ?? [])]
    .filter((entry) => entry.disabled !== true)
    .filter((entry) => typeof entry.options?.name === 'string' && entry.options.name.startsWith('@deepseek-ai/'))
  // A profile with no official entries is not something this check can reason about. Staying silent keeps
  // it from turning an unusual layout into a false alarm.
  if (official.length === 0) return { checked: 0, active: 0 }

  const active = official.filter((entry) => entry.fiber?.state === fiberActive).length
  if (active === 0) {
    const seen = [...new Set(official.map((entry) => entry.fiber?.state ?? 'no fiber'))].join(', ')
    throw new Error(
      `host-contract-changed: none of the ${official.length} official @deepseek-ai/ entries report fiber state `
      + `${fiberActive} (saw: ${seen}). The host's state enum may have changed, which makes this tool's `
      + 'activation check meaningless. This says nothing about the plugin under test.',
    )
  }
  return { checked: official.length, active }
}

/** Cordis marks a running fiber with this enum value. */
export function verifyActivation(ctx, extra = {}) {
  const loader = ctx.get('loader')
  assert.ok(loader, 'profile exited before runtime acceptance')
  const entries = [...loader.entries()]
  const inactive = []
  for (const entry of entries) {
    if (entry.disabled || entry.fiber?.state === FIBER_ACTIVE) continue
    const fiber = entry.fiber
    const missing = fiber === undefined ? [] : Object.keys(fiber.inject ?? {}).filter(name => fiber.ctx.get(name) === undefined)
    inactive.push(`${entry.options.id ?? '?'} (${entry.options.name}): ${fiber === undefined ? 'not loaded' : `fiber state ${fiber.state}`}${missing.length ? `, waiting for ${missing.join(', ')}` : ''}`)
  }
  assert.equal(inactive.length, 0, `profile entries did not activate:\n${inactive.join('\n')}`)

  // "Every entry that is present activated" is not the same claim as "the plugin under test
  // activated". A plugin that never got mounted — no bundle entry, its own patch sets
  // `disabled: true`, the loader skipped it — leaves the assertion above satisfied, because it
  // simply is not in the list. That is how a rehearsal could pass for a plugin that never loaded.
  if (Array.isArray(extra.plugins)) {
    for (const name of extra.plugins) {
      const named = entries.filter(entry => typeof entry.options?.name === 'string' &&
        (entry.options.name === name || entry.options.name.startsWith(`${name}/`)))
      assert.ok(named.length, `${name} never entered the profile`)
      assert.ok(named.every(entry => !entry.disabled && entry.fiber?.state === FIBER_ACTIVE), `${name} did not activate`)
    }
  } else if (typeof extra.plugin === 'string' && extra.plugin !== '') {
    // Exact matches only, on the package name and on the entry id.
    //
    // These used to be `name === plugin || id.includes(plugin)`, and the substring half made the
    // whole assertion satisfiable by a neighbour: with `dsh-x` under test, an activated `dsh-x-ui`
    // entry — a different package — passed as proof. A plugin that was disabled or absent then
    // looked like it had loaded.
    const named = entries.filter((entry) => entry.options?.name === extra.plugin
      || entry.options?.id === extra.plugin)
    assert.ok(
      named.length > 0,
      `${extra.plugin} never entered the profile: it is not among the ${entries.length} loaded entries`,
    )
    // Every entry carrying that name has to be active. One disabled duplicate is enough to mean the
    // plugin under test did not load.
    const inactiveMatches = named.filter((entry) => entry.disabled || entry.fiber?.state !== FIBER_ACTIVE)
    assert.equal(
      inactiveMatches.length,
      0,
      `${extra.plugin} was present but did not activate: ${
        inactiveMatches.map((entry) => `${entry.options?.id ?? '?'}=${entry.disabled ? 'disabled' : `state ${entry.fiber?.state}`}`).join(', ')
      }`,
    )
  }
}

/**
 * Execute one tool call through the host's tool service.
 *
 * The shape of `execute` changed between host lines, and both are still in the field:
 *
 *   - 0.2.1.x  `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` — one call
 *   - 0.2.2.x  `execute(input: ToolBatchInput): Promise<ToolBatchResult>` — a batch of model calls
 *
 * The capability that tells them apart is `executable()`, which arrived with the batch shape; a version
 * table would need updating on every host release and would be wrong for anything not in it. It is tested
 * rather than assumed, and the mode is recorded so a report says which contract it exercised.
 *
 * @param {object} runtime - the host's `tools` service.
 * @param {string} callId - correlation id for this call.
 * @param {{name: string, arguments: object}} call - the assertion from the caller.
 * @param {'single'|'batch'} mode - which contract to use.
 * @returns {Promise<object>} the execution result, in either shape.
 */
export async function executeToolCall(runtime, callId, call, mode) {
  if (mode === 'single') {
    return runtime.execute({ callId, name: call.name, arguments: call.arguments, signal: new AbortController().signal })
  }
  // `arguments` is the raw JSON string the model would have produced — the batch API parses it itself.
  const batch = await runtime.execute({
    calls: [{ type: 'tool-call', id: callId, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }],
    signal: new AbortController().signal,
  })
  const settled = batch?.results?.find((row) => row.callId === callId) ?? batch?.results?.[0]
  assert.ok(settled, `no result for ${call.name}: ${JSON.stringify(batch)}`)
  return settled.result
}

/** Registration alone does not prove execution; callers can supply real tool calls too. */
export async function verifyTools(ctx, tools, calls) {
  const runtime = ctx.get('tools')
  const mode = typeof runtime?.executable === 'function' ? 'batch' : 'single'
  const registered = []
  for (const name of new Set([...tools, ...calls.map(call => call.name)])) {
    assert.ok(runtime?.get(name), `tool did not register: ${name}`)
    registered.push(name)
  }
  const executed = []
  for (const [index, call] of calls.entries()) {
    const result = await executeToolCall(runtime, `health-smoke-${index}`, call, mode)
    assert.notEqual(result.isError, true, `tool returned an error: ${call.name}: ${JSON.stringify(result)}`)
    if (Object.hasOwn(call, 'expectedValue')) assert.deepEqual(result.value, call.expectedValue, `unexpected value from ${call.name}`)
    executed.push({ name: call.name, ok: true })
  }
  return { registered, executed, toolApi: mode }
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

/**
 * What the booted profile occupies: every loader entry, and every tool name the tool service can see.
 *
 * Recorded whether or not tool assertions run, and before the activation assertions, so a failed boot still
 * shows what did register. Two plugins that both register `web_search` only collide when installed together;
 * this is the data that lets a batch run predict that without installing every pair.
 *
 * Tool names come from the public `definitions()` of the tools service (present in
 * `@deepseek-ai/dsh-tools@0.2.2-rc.1`). A host without it, or one that throws, records `toolsUnavailable`
 * instead of failing the run: the footprint is evidence, not an assertion.
 *
 * @param {object} ctx - host context from `runProfile`.
 * @returns {{entries: Array<{id: string|null, name: string|null, state: number|null, disabled: boolean}>, tools: string[], toolsUnavailable: boolean}}
 */
export function describeFootprint(ctx) {
  const entries = []
  for (const entry of ctx.get('loader')?.entries?.() ?? []) {
    entries.push({
      id: entry.options?.id ?? null,
      name: entry.options?.name ?? null,
      state: entry.fiber?.state ?? null,
      disabled: entry.disabled === true,
    })
  }
  let tools = []
  let toolsUnavailable = false
  try {
    const definitions = ctx.get('tools')?.definitions?.()
    if (definitions === undefined) toolsUnavailable = true
    else tools = [...new Set([...definitions].map((definition) => definition?.name).filter((name) => typeof name === 'string'))].sort()
  } catch {
    toolsUnavailable = true
  }
  return { entries, tools, toolsUnavailable }
}

/**
 * The version of `@deepseek-ai/cordis` the host itself carries.
 *
 * Recorded so a result can be reproduced: the activation rule depends on that package's state enum, and the
 * host directory is the only place the exact installed version is knowable.
 *
 * @param {string} hostDir - directory containing the installed `@deepseek-ai/dsh`.
 * @returns {string|null} version, or null when it cannot be resolved.
 */
export function hostCordisVersion(hostDir) {
  try {
    const requireHost = createRequire(join(hostDir, 'package.json'))
    const manifest = JSON.parse(readFileSync(requireHost.resolve('@deepseek-ai/cordis/package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Command-line arguments for the booted tree. Only one fixed set is ever passed, never anything from a plugin or a
 * request: with the web app in the profile, `--port 0` lets the OS choose a free port (the default 3080 collides
 * when trials run side by side, and the second one's web services never start), and `--no-open` keeps every
 * trial from opening a browser window. Both are the web app's own documented flags.
 * @param {{webApp?: boolean}} config
 * @returns {string[]}
 */
export function launchArgs(config) {
  return config?.webApp === true ? ['--port', '0', '--no-open'] : []
}

async function main(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const report = { ok: false, stage: 'boot', hostCordis: hostCordisVersion(config.hostDir) }
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
      environment: loadLayeredEnv('dsh-health-smoke'), profile: config.profile, patchFiles: [], args: launchArgs(config),
    }))
    report.footprint = describeFootprint(ctx)
    save()
    // Check the control group first. If the host's state enum moved, the assertions below would report
    // "did not activate" for a plugin that is fine, which sends the reader after the wrong thing.
    report.hostContract = checkHostContract(ctx)
    // Some hosts only warn about pending entries; do not turn that into a green smoke result.
    verifyActivation(ctx, { plugin: config.plugin, plugins: config.plugins })
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
