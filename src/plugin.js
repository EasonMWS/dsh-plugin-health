/**
 * DSH bundle plugin entry: exposes a read-only `plugin_health` agent tool.
 *
 * The module is loaded by the DSH Loader when a profile installs this package as a bundle
 * (`dsh plugin add dsh-plugin-health`). It registers the tool when the host `tools` service and
 * `@deepseek-ai/dsh-tools` are available; otherwise it stays a harmless no-op so a CLI-only
 * installation never breaks a host.
 * @module plugin
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { inspectDshHome } from './repair/inspect.js'
import { formatInspection } from './repair/format.js'
import { cachedStatus, runningProfile } from './ui/status.js'
import { registerRepairRoute } from './ui/repair-route.js'
import { registerRescueRoute } from './ui/rescue-route.js'

export const name = 'plugin-health'
export const inject = ['tools']

/**
 * Read the host DSH version when the host's `dsh-app-boot` package is resolvable.
 * @returns {string|undefined} semantic version, or undefined when it cannot be read.
 */
export function hostRuntimeVersion() {
  try {
    const require = createRequire(import.meta.url)
    let directory = dirname(require.resolve('@deepseek-ai/dsh-app-boot'))
    for (let depth = 0; depth < 8; depth += 1) {
      const manifestPath = join(directory, 'package.json')
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          if (manifest.name === '@deepseek-ai/dsh-app-boot' && typeof manifest.version === 'string') return manifest.version
        } catch {
          // keep walking
        }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch {
    // no host package: the tool simply skips the compatibility section
  }
  return undefined
}

/**
 * Format one inspection result for the agent tool.
 * @param {{profile?: string, runtime?: string, json?: boolean}} args - tool arguments.
 * @returns {string} JSON or text report.
 */
export function inspectionText({ profile, runtime, json } = {}) {
  const result = inspectDshHome({
    profile,
    runtimeVersion: runtime ?? hostRuntimeVersion(),
  })
  return json === true ? JSON.stringify(result, null, 2) : formatInspection(result)
}

/**
 * Cordis plugin entry: register the `plugin_health` tool when possible.
 * @param {object} ctx - Cordis context.
 * @returns {Promise<void>} resolves after the tool is registered or the fallback decided.
 */
export async function apply(ctx) {
  // Browser UI: read-only snapshot, the quarantine repair route, and the rescue routes.
  // All are loopback-only; the mutating ones also require the per-launch control key.
  try {
    if (typeof ctx?.inject === 'function') {
      const resolveProfile = () => runningProfile(ctx)
      const key = registerRepairRoute(ctx, {
        resolveProfile,
        getStatus: () => cachedStatus({ ...resolveProfile(), runtimeVersion: hostRuntimeVersion() }),
      })
      registerRescueRoute(ctx, { currentProfile: resolveProfile, key })
    }
  } catch (error) {
    try {
      ctx?.logger?.debug?.(`[plugin-health] UI routes skipped: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // logging is best effort only
    }
  }

  try {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    if (ctx?.tools?.register === undefined) return
    ctx.tools.register(defineTool({
      name: 'plugin_health',
      description: 'Check, diagnose and manage installed DeepSeek Harness plugins. Use this when the user asks to check, scan, inspect, diagnose, repair or manage their plugins, when a plugin stopped working after a DSH update, or when plugins seem to conflict. Scans EVERY plugin installed in the profile (bundles, dependencies, cordis.patch.yml inserts, node_modules) and reports: plugins incompatible with the running DSH version, declared but missing bundles, broken package directories, patch residue, proxy/registry misconfiguration, and profile drift. Read-only by default: it changes nothing unless repair is explicitly requested.',
      parameters: {
        profile: { type: 'string', description: 'Profile name; defaults to desktop, then web, then the first profile.' },
        runtime: { type: 'string', description: 'DSH version used for compatibility checks; defaults to the host version when readable.' },
        json: { type: 'boolean', description: 'Return the structured JSON result instead of a text report.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return inspectionText({ profile: args.profile, runtime: args.runtime, json: args.json })
      },
    }))
  } catch (error) {
    try {
      ctx?.logger?.debug?.(`[plugin-health] tool registration skipped: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // logging is best effort only
    }
  }
}

export default { name, inject, apply }
