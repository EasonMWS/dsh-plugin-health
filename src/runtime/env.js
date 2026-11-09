/**
 * The environment a plugin under test is allowed to see.
 *
 * `smoke` used to hand the plugin `{ ...process.env }`. For a rehearsal of your own plugin that is defensible —
 * the README said so, and you already trust the code. For a batch run over plugins you have never read, it
 * means every token in the CI environment is handed to third-party code that then runs with your permissions.
 *
 * So the choice is explicit: `cleanEnv: false` keeps the old behaviour, and `cleanEnv: true` passes only what
 * a host and a package manager actually need. The allowlist is deliberately a list, not a blocklist — a
 * blocklist of secret-looking names is always one naming convention behind.
 * @module runtime/env
 */

/** Names passed through when the environment is cleaned, compared case-insensitively. */
const ALLOWED = new Set([
  // A host and the shell it spawns need these to start at all.
  'path', 'home', 'tmpdir', 'temp', 'tmp', 'lang', 'lc_all', 'lc_ctype', 'tz', 'ci',
  // Windows keeps a different set, and its names are matched case-insensitively below, so `Path` and `PATH`
  // are the same entry here.
  'userprofile', 'homedrive', 'homepath', 'systemroot', 'systemdrive', 'windir', 'comspec', 'pathext',
  'appdata', 'localappdata', 'programdata', 'programfiles', 'number_of_processors', 'processor_architecture',
  // Reaching the registry is part of installing, so proxies and package-manager caches have to survive.
  'http_proxy', 'https_proxy', 'no_proxy', 'node_extra_ca_certs', 'npm_config_registry', 'npm_config_cache',
  'pnpm_home', 'xdg_cache_home', 'xdg_data_home', 'xdg_config_home',
])

/**
 * A name that looks like a credential is never passed, even if it is on the allowlist.
 *
 * The allowlist already excludes these; this is the second lock on the same door, because one wrong addition
 * to the list above would otherwise hand out a token.
 */
const LOOKS_LIKE_SECRET = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|NPM_TOKEN|NODE_AUTH)/iu

/** Variables CI systems inject that describe the job rather than the machine. */
const CI_INJECTED = /^(?:ACTIONS_|GITHUB_|RUNNER_)/iu

/**
 * Build the environment for a cleaned run.
 *
 * @param {Record<string, string|undefined>} source - normally `process.env`.
 * @param {{home: string}} options - the temporary DSH home to point the run at.
 * @returns {{env: Record<string, string>, passed: string[]}} the environment and the names of what went into
 *   it. Values are never recorded: a report is meant to be shareable.
 */
export function cleanEnvironment(source, { home }) {
  const env = {}
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value !== 'string') continue
    if (LOOKS_LIKE_SECRET.test(name) || CI_INJECTED.test(name)) continue
    if (!ALLOWED.has(name.toLowerCase())) continue
    env[name] = value
  }
  env.DSH_HOME = home
  env.DSH_TELEMETRY_DISABLED = '1'
  return { env, passed: Object.keys(env) }
}

/**
 * The environment for a run, and what to record about it.
 *
 * @param {{clean: boolean, source?: Record<string, string|undefined>, home: string}} options
 * @returns {{env: Record<string, string>, report: {mode: 'clean'|'inherited', passed: string[]}}}
 */
export function environmentForRun({ clean, source = process.env, home }) {
  if (clean !== true) {
    return {
      env: { ...source, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      // Names are not listed: there is no allowlist decision to report, and the list would be the whole
      // process environment.
      report: { mode: 'inherited', passed: [] },
    }
  }
  const { env, passed } = cleanEnvironment(source, { home })
  return { env, report: { mode: 'clean', passed } }
}