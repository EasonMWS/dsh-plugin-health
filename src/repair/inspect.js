/**
 * Read-only diagnostics for a local DSH home, focused on the Windows/WSL install-time failures the
 * generic doctor tools do not cover: missing bundles, partial package directories, patch residue,
 * atomic-write lock leftovers, proxy/registry mismatch, and cross-profile drift.
 * @module repair/inspect
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { evaluatePluginCompatibility } from '../compat/evaluate.js'
import { readExemptions } from '../rescue/rescue.js'

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 }

/**
 * Resolve the DSH home directory: explicit option, `DSH_HOME`, then `~/.dsh`.
 * @param {string|undefined} explicit - caller-provided home.
 * @returns {string} absolute-ish home path.
 */
export function resolveDshHome(explicit) {
  return explicit !== undefined && explicit !== '' ? explicit : (process.env.DSH_HOME || join(homedir(), '.dsh'))
}

/**
 * List profile names under a DSH home.
 * @param {string} home - DSH home.
 * @returns {string[]} profile directory names.
 */
export function listProfiles(home) {
  const directory = join(home, 'profiles')
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

function nodeModulesPath(profileDir, name) {
  return join(profileDir, 'node_modules', ...name.split('/'))
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function safeReadJson(filename) {
  try {
    return { value: readJson(filename) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function finding(id, severity, title, detail, extra = {}) {
  return { id, severity, title, detail, ...extra }
}

/**
 * Inspect a DSH home/profile and return structured findings.
 * @param {{home?: string, profile?: string, runtimeVersion?: string}} [options]
 * @returns {{home: string, profiles: string[], profile: string|undefined, profileDir: string|undefined, findings: object[], summary: object}}
 */
export function inspectDshHome({ home, profile, runtimeVersion } = {}) {
  const resolvedHome = resolveDshHome(home)
  const findings = []
  const profiles = listProfiles(resolvedHome)
  const result = { home: resolvedHome, profiles, profile: undefined, profileDir: undefined, findings, summary: {} }

  if (!existsSync(resolvedHome)) {
    findings.push(finding('home-missing', 'error', `DSH home does not exist: ${resolvedHome}`, 'Set --home or DSH_HOME to the directory that contains profiles/.'))
    return withSummary(result)
  }
  if (profiles.length === 0) {
    findings.push(finding('profiles-missing', 'warn', `No profiles under ${join(resolvedHome, 'profiles')}`, 'Start DSH once (dsh web or the desktop app) to create a profile.'))
    return withSummary(result)
  }

  const selected = profile !== undefined && profile !== ''
    ? profile
    : (profiles.includes('desktop') ? 'desktop' : profiles.includes('web') ? 'web' : profiles[0])
  const profileDir = join(resolvedHome, 'profiles', selected)
  result.profile = selected
  result.profileDir = profileDir
  if (!existsSync(profileDir)) {
    findings.push(finding('profile-missing', 'error', `Profile directory does not exist: ${profileDir}`, `Available profiles: ${profiles.join(', ')}`))
    return withSummary(result)
  }

  const manifestPath = join(profileDir, 'package.json')
  let manifest
  if (!existsSync(manifestPath)) {
    findings.push(finding('profile-manifest-missing', 'error', 'Profile package.json is missing', manifestPath))
  } else {
    const read = safeReadJson(manifestPath)
    if (read.error !== undefined) {
      findings.push(finding('profile-manifest-invalid', 'error', 'Profile package.json is not valid JSON', `${manifestPath}: ${read.error}`))
    } else {
      manifest = read.value
    }
  }

  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  if (manifest !== undefined && bundles.length === 0) {
    findings.push(finding('profile-bundles-empty', 'warn', 'Profile declares no bundles', 'The profile may not boot; check dsh.profile.bundles in package.json.'))
  }
  for (const name of bundles) {
    if (typeof name !== 'string') continue
    // Bundles shipped with the DSH installation are provided by it and are not copied into the profile.
    if (name.startsWith('@deepseek-ai/')) continue
    const directory = nodeModulesPath(profileDir, name)
    const packageJson = join(directory, 'package.json')
    if (!existsSync(packageJson)) {
      findings.push(finding('bundle-missing', 'error', `Declared bundle is not installed: ${name}`,
        `Expected ${packageJson}.`, { fix: { kind: 'manual', description: `Install it with: dsh plugin --profile ${selected} add ${name}` } }))
      continue
    }
    const read = safeReadJson(packageJson)
    if (read.error !== undefined) {
      findings.push(finding('bundle-manifest-invalid', 'error', `Bundle has an unreadable package.json: ${name}`, `${packageJson}: ${read.error}`,
        { fix: { kind: 'quarantine', auto: true, target: directory, description: 'Move the broken bundle directory to quarantine.' } }))
    }
  }

  if (manifest !== undefined && manifest.dependencies !== null && typeof manifest.dependencies === 'object') {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (typeof spec !== 'string' || /^(workspace:|file:|link:|git\+|https?:)/.test(spec)) continue
      if (!existsSync(nodeModulesPath(profileDir, name))) {
        findings.push(finding('dependency-missing', 'warn', `Profile dependency is not installed: ${name}`,
          `Declared ${spec} but node_modules/${name} is missing.`, { fix: { kind: 'manual', description: `Run pnpm install in ${profileDir} or reinstall the plugin.` } }))
      }
    }
  }

  inspectPatch(profileDir, findings)
  inspectNodeModules(profileDir, manifest, findings)
  inspectResidue(profileDir, findings)
  inspectLogs(profileDir, findings)
  inspectEnvironment(resolvedHome, profileDir, findings)
  const incompatiblePlugins = []
  inspectRuntime(profileDir, bundles, runtimeVersion, findings, manifest, incompatiblePlugins)
  inspectProfileDrift(resolvedHome, selected, findings)
  result.incompatiblePlugins = incompatiblePlugins

  // How many plugins were actually checked, so the UI can say "checked N" instead of implying a
  // sample. Host packages are reported separately because they are the reference, not the subject.
  if (manifest !== undefined) {
    const installed = listInstalledPlugins(profileDir, manifest)
    result.scannedPlugins = {
      total: installed.length,
      thirdParty: installed.filter((item) => !item.name.startsWith('@deepseek-ai/')).length,
    }
  }

  return withSummary(result)
}

function inspectPatch(profileDir, findings) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return
  let parsed
  try {
    parsed = parseYaml(readFileSync(patchPath, 'utf8'))
  } catch (error) {
    findings.push(finding('patch-invalid', 'error', 'cordis.patch.yml cannot be parsed', `${patchPath}: ${error instanceof Error ? error.message : String(error)}`,
      { fix: { kind: 'manual', description: 'Fix the YAML or restore the file from a backup before starting DSH.' } }))
    return
  }
  if (!Array.isArray(parsed)) {
    findings.push(finding('patch-not-array', 'error', 'cordis.patch.yml must contain a YAML array of patch entries', patchPath,
      { fix: { kind: 'manual', description: 'Restore a known-good patch file; DSH expects a top-level array.' } }))
    return
  }
  const emptyEntries = parsed.filter((entry) => Array.isArray(entry) && entry.length === 0)
  if (emptyEntries.length > 0) {
    findings.push(finding('patch-empty-entry', 'warn', 'cordis.patch.yml contains empty [] patch entries',
      `${emptyEntries.length} empty array entr${emptyEntries.length === 1 ? 'y' : 'ies'} can make composition fail on some DSH versions.`,
      { fix: { kind: 'rewrite-patch', auto: true, path: patchPath, description: 'Remove top-level empty [] entries and back up the original file.' } }))
  }
  const invalid = parsed.filter((entry) => entry === null || typeof entry !== 'object' || (Array.isArray(entry) && entry.length > 0))
  if (invalid.length > 0) {
    findings.push(finding('patch-invalid-entry', 'warn', 'cordis.patch.yml contains non-object patch entries', `${invalid.length} entries are not objects.`,
      { fix: { kind: 'manual', description: 'Remove the non-object entries by hand.' } }))
  }
}

function inspectNodeModules(profileDir, manifest, findings) {
  const directory = join(profileDir, 'node_modules')
  if (!existsSync(directory)) return
  const referenced = new Set([
    ...(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []),
    ...Object.keys(manifest?.dependencies ?? {}),
  ])
  const candidates = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(directory, entry.name)
      let children = []
      try { children = readdirSync(scopeDir, { withFileTypes: true }) } catch { continue }
      for (const child of children) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        candidates.push({ name: `${entry.name}/${child.name}`, directory: join(scopeDir, child.name) })
      }
      continue
    }
    candidates.push({ name: entry.name, directory: join(directory, entry.name) })
  }
  for (const candidate of candidates) {
    const relevant = referenced.has(candidate.name) || /dsh/i.test(candidate.name)
    if (!relevant) continue
    const packageJson = join(candidate.directory, 'package.json')
    if (!existsSync(packageJson)) {
      findings.push(finding('package-dir-broken', 'warn', `Package directory has no package.json: ${candidate.name}`,
        candidate.directory,
        { fix: { kind: 'quarantine', auto: true, target: candidate.directory, description: 'Move the partial directory to quarantine, then reinstall the package.' } }))
      continue
    }
    const read = safeReadJson(packageJson)
    if (read.error !== undefined) {
      findings.push(finding('package-dir-broken', 'warn', `Package directory has an unreadable package.json: ${candidate.name}`,
        `${packageJson}: ${read.error}`,
        { fix: { kind: 'quarantine', auto: true, target: candidate.directory, description: 'Move the broken directory to quarantine, then reinstall the package.' } }))
    }
  }
}

function inspectResidue(profileDir, findings) {
  const roots = [profileDir, join(profileDir, 'node_modules')]
  const patterns = [/\.bak-/u, /\.lock$/u, /\.lock\.takeover-/u]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (patterns.some((pattern) => pattern.test(entry.name))) {
        findings.push(finding('residue', 'warn', `Stale residue file: ${entry.name}`, join(root, entry.name),
          { fix: { kind: 'quarantine', auto: true, target: join(root, entry.name), description: 'Move the residue file to quarantine; it can be restored from there.' } }))
      }
    }
  }
}

function inspectLogs(profileDir, findings) {
  const logs = join(profileDir, '.plugin-manager', 'logs')
  if (!existsSync(logs)) return
  let bytes = 0
  try {
    for (const entry of readdirSync(logs, { withFileTypes: true })) {
      if (entry.isFile()) bytes += statSync(join(logs, entry.name)).size
    }
  } catch { return }
  if (bytes > 32 * 1024 * 1024) {
    findings.push(finding('logs-large', 'info', 'Plugin-manager logs are large', `${(bytes / 1024 / 1024).toFixed(1)} MiB under ${logs}.`,
      { fix: { kind: 'manual', description: 'Archive or delete old logs while DSH is stopped.' } }))
  }
}

function inspectEnvironment(home, profileDir, findings) {
  const proxy = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].find((name) => process.env[name] !== undefined && process.env[name] !== '')
  if (proxy !== undefined && process.env.NODE_USE_ENV_PROXY === undefined) {
    findings.push(finding('proxy-env', 'warn', `Proxy is configured (${proxy}) but Node fetch may ignore it`,
      'DSH market/install requests use global fetch; Node only honours proxy environment variables with NODE_USE_ENV_PROXY=1 (Node 20+).',
      { fix: { kind: 'manual', description: 'Set NODE_USE_ENV_PROXY=1 in the environment that starts DSH, or configure the npm registry mirror.' } }))
  }
  if (platform() === 'linux') {
    try {
      const version = readFileSync('/proc/version', 'utf8')
      if (/microsoft/i.test(version)) {
        findings.push(finding('wsl-detected', 'info', 'WSL environment detected', 'Windows paths and native binaries behave differently from native Linux; check /mnt mount performance and CRLF handling.'))
      }
    } catch { /* not Linux or unreadable */ }
  }
  if (platform() === 'win32' && profileDir.length > 240) {
    findings.push(finding('long-path', 'warn', 'Profile path is long for Windows', `${profileDir.length} characters; enable long-path support and prefer a short DSH_HOME.`))
  }
  const npmrc = join(home, '.npmrc')
  if (existsSync(npmrc)) {
    try {
      const registry = readFileSync(npmrc, 'utf8').match(/^registry\s*=\s*(.+)$/mu)?.[1]?.trim()
      if (registry !== undefined && !/^https:\/\/registry\.npmjs\.org\/?$/u.test(registry)) {
        findings.push(finding('registry-mirror', 'info', `Custom npm registry: ${registry}`, 'Plugin installs use this registry; confirm it serves the versions the market lists.'))
      }
    } catch { /* unreadable */ }
  }
}

/**
 * Every plugin package actually installed in a profile, not just the ones listed in
 * `dsh.profile.bundles`.
 *
 * A profile can also pull plugins in through `cordis.patch.yml` insert entries, and pnpm keeps
 * packages in `node_modules` that the bundle list does not mention. Checking only `bundles` reports
 * a clean profile while a broken plugin sits right next to it.
 * @param {string} profileDir - profile directory.
 * @param {object} manifest - the profile package.json.
 * @returns {{name: string, directory: string, source: string}[]} installed plugins, de-duplicated.
 */
export function listInstalledPlugins(profileDir, manifest) {
  /** @type {Map<string, {name: string, directory: string, source: string}>} */
  const found = new Map()

  const add = (name, directory, source) => {
    if (typeof name !== 'string' || name === '') return
    if (found.has(name)) return
    found.set(name, { name, directory, source })
  }

  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  for (const name of bundles) add(name, nodeModulesPath(profileDir, name), 'bundle')

  // Dependencies of the profile package: what pnpm actually installed for this profile.
  for (const name of Object.keys(manifest?.dependencies ?? {})) {
    add(name, nodeModulesPath(profileDir, name), 'dependency')
  }

  // Plugins wired in through the patch layer, which the bundle list does not have to mention.
  for (const name of readPatchPluginNames(profileDir)) {
    add(name, nodeModulesPath(profileDir, name), 'patch')
  }

  // Anything else that looks like a dsh plugin and is physically present.
  const directory = join(profileDir, 'node_modules')
  if (existsSync(directory)) {
    for (const candidate of listPackageDirectories(directory)) {
      if (!/dsh/i.test(candidate.name)) continue
      add(candidate.name, candidate.directory, 'node_modules')
    }
  }

  return [...found.values()]
}

/**
 * Package names referenced by `cordis.patch.yml`, including nested insert lists.
 * @param {string} profileDir - profile directory.
 * @returns {string[]} package names mentioned by the patch layer.
 */
function readPatchPluginNames(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return []
  let parsed
  try {
    parsed = parseYaml(readFileSync(patchPath, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const names = []
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.name === 'string' && node.name !== '') names.push(node.name)
    if (node.insert !== undefined) visit(node.insert)
  }
  visit(parsed)
  return names
}

/**
 * Walk `node_modules`, expanding scope directories, without following links into other trees.
 * @param {string} directory - a node_modules directory.
 * @returns {{name: string, directory: string}[]} package directories.
 */
function listPackageDirectories(directory) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(directory, entry.name)
      let children = []
      try {
        children = readdirSync(scopeDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        out.push({ name: `${entry.name}/${child.name}`, directory: join(scopeDir, child.name) })
      }
      continue
    }
    out.push({ name: entry.name, directory: join(directory, entry.name) })
  }
  return out
}

/**
 * Map package name → the id its patch-layer entry uses, including nested `insert` lists.
 *
 * The profile registers a bundle as `{ id: <short-name>, name: <package> }`, and disabling it
 * later has to address the entry by that id. Nested inserts appear in real profiles, so the
 * walk is recursive rather than one level deep.
 * @param {string} profileDir
 * @returns {Map<string, string>}
 */
function patchEntryIds(profileDir) {
  const ids = new Map()
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) return ids
  let parsed
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'))
  } catch {
    return ids
  }
  const visit = (list) => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue
      if (typeof entry.name === 'string' && typeof entry.id === 'string') {
        if (!ids.has(entry.name)) ids.set(entry.name, entry.id)
      }
      visit(entry.insert)
    }
  }
  visit(parsed)
  return ids
}

function inspectRuntime(profileDir, bundles, runtimeVersion, findings, manifest, incompatible = []) {
  if (runtimeVersion === undefined || runtimeVersion === '') return
  // The host honours exact-version exemptions from this file, so a scan that ignores it
  // reports a plugin as broken after the user already fixed it — exactly the kind of
  // "the checker lies" behaviour this tool exists to avoid.
  const exemptions = readExemptions(profileDir)
  // The patch-layer id, so switching a plugin off can target the entry the profile actually
  // registers. A bundle inserted as `id: plugin-health` has a name that is not that id.
  const idByName = patchEntryIds(profileDir)
  const installed = manifest === undefined
    ? bundles.map((name) => ({ name, directory: nodeModulesPath(profileDir, name) }))
    : listInstalledPlugins(profileDir, manifest)
  const seen = new Set()
  for (const plugin of installed) {
    const name = plugin.name
    if (typeof name !== 'string' || name === '') continue
    if (seen.has(name)) continue
    seen.add(name)
    if (name.startsWith('@deepseek-ai/')) continue // host packages are the reference, not plugins
    const manifestPath = join(plugin.directory ?? nodeModulesPath(profileDir, name), 'package.json')
    if (!existsSync(manifestPath)) continue
    const read = safeReadJson(manifestPath)
    if (read.error !== undefined) continue
    try {
      const issue = evaluatePluginCompatibility(read.value, { runtimeVersion, exemptions })
      if (issue !== undefined && !issue.exempted) {
        findings.push(finding('plugin-incompatible', 'warn', `Installed plugin is incompatible with dsh ${runtimeVersion}: ${issue.name}@${issue.version}`,
          `Unmet requirements: ${Object.entries(issue.requirements).map(([key, range]) => `${key} ${range}`).join(', ')}.`,
          { fix: { kind: 'manual', description: 'Update the plugin, install a compatible version, or grant an exact-version exemption.' } }))
        // Carry the identity forward so the rescue flow can rehearse this exact version
        // without re-parsing the finding title.
        incompatible.push({ name: issue.name, version: issue.version, requirements: issue.requirements, id: idByName.get(issue.name) ?? null })
      }
    } catch {
      findings.push(finding('plugin-manifest-invalid', 'warn', `Cannot evaluate requirements for ${name}`, manifestPath))
    }
  }
}

function inspectProfileDrift(home, selected, findings) {
  const profiles = listProfiles(home)
  if (profiles.length < 2) return
  const readBundles = (name) => {
    try {
      const value = readJson(join(home, 'profiles', name, 'package.json'))
      return Array.isArray(value?.dsh?.profile?.bundles) ? value.dsh.profile.bundles : []
    } catch {
      return []
    }
  }
  const selectedBundles = new Set(readBundles(selected))
  const others = profiles.filter((name) => name !== selected)
  for (const other of others) {
    const otherBundles = new Set(readBundles(other))
    const missing = [...otherBundles].filter((name) => !selectedBundles.has(name))
    const extra = [...selectedBundles].filter((name) => !otherBundles.has(name))
    if (missing.length > 0 || extra.length > 0) {
      findings.push(finding('profile-drift', 'info', `Profile "${selected}" and "${other}" have different plugin sets`,
        [`only in ${other}: ${missing.join(', ') || '(none)'}`, `only in ${selected}: ${extra.join(', ') || '(none)'}`].join('; '),
        { fix: { kind: 'manual', description: 'Install the missing bundles in the other profile deliberately; profiles are isolated by design.' } }))
    }
  }
}

function withSummary(result) {
  const summary = { error: 0, warn: 0, info: 0, autoFixable: 0 }
  result.findings.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
  for (const item of result.findings) {
    summary[item.severity] += 1
    if (item.fix?.auto === true) summary.autoFixable += 1
  }
  result.summary = summary
  return result
}

export { SEVERITY_ORDER }
