import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import semver from 'semver'
import { parseDocument } from 'yaml'
import { evaluatePluginCompatibility } from '../compat/evaluate.js'
import { listInstalledPlugins, listProfiles, resolveDshHome } from '../repair/inspect.js'
import { EXEMPTION_FILE } from '../rescue/rescue.js'

const PATCH = 'cordis.patch.yml'
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const HOST_PACKAGES = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope'])
const RESOURCE_SCOPES = new Set(['workspace', 'profile', 'dsh-home'])
const digest = (value) => createHash('sha256').update(value).digest('hex')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function readBoundedText(path, limit = 1024 * 1024) {
  if (!statSync(path).isFile()) throw new Error('not a regular file')
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('not a regular file within the scan size limit')
    const data = Buffer.allocUnsafe(stat.size + 1)
    let offset = 0
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset !== stat.size) throw new Error('file changed during scan')
    return data.subarray(0, offset).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function readPackage(directory) {
  const raw = readBoundedText(join(directory, 'package.json'))
  const manifest = JSON.parse(raw.replace(/^\uFEFF/u, ''))
  if (!isObject(manifest)) throw new Error('invalid package manifest')
  return { manifest, fingerprint: digest(raw) }
}

function bundlePatch(root, file) {
  if (typeof file !== 'string' || isAbsolute(file)) throw new Error('invalid bundle patch path')
  const resolvedRoot = realpathSync(root)
  const path = realpathSync(resolve(resolvedRoot, file))
  const tail = relative(resolvedRoot, path)
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) {
    throw new Error('bundle patch points outside the package')
  }
  return path
}

function declaration(manifest, target, exemptions) {
  if (!target) return { state: 'not-checked' }
  const declared = Object.hasOwn(manifest.engines ?? {}, 'dsh') ||
    Object.keys(manifest.peerDependencies ?? {}).some(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  try {
    const result = evaluatePluginCompatibility(manifest, { runtimeVersion: target, exemptions })
    if (result) return { state: result.exempted ? 'exempted' : 'incompatible', requirements: result.requirements }
    return { state: declared ? 'compatible' : 'undeclared' }
  } catch {
    return { state: 'unknown' }
  }
}

function findDeclaredWriteOverlap(manifests, limits) {
  const writers = new Map()
  let declared = 0
  for (const [name, { manifest }] of manifests) {
    if (name.startsWith('@deepseek-ai/')) continue
    const resources = manifest.dshPluginHealth?.resources
    if (resources === undefined) continue
    if (manifest.dshPluginHealth.version !== 1 || !Array.isArray(resources) || resources.length > 256) {
      limits.add('invalid-resource-declaration')
      continue
    }
    declared += 1
    for (const entry of resources) {
      const path = typeof entry?.path === 'string' ? entry.path.replaceAll('\\', '/') : ''
      if (!RESOURCE_SCOPES.has(entry?.scope) || !['read', 'write'].includes(entry?.access) ||
          !path || path.length > 512 || /[:*?<>|"\x00-\x1f]/u.test(path) ||
          path.split('/').some(part => !part || part === '.' || part === '..')) {
        limits.add('invalid-resource-declaration')
        continue
      }
      if (entry.access !== 'write') continue
      const normalized = process.platform === 'win32' ? path.toLowerCase() : path
      const key = `${entry.scope}:${normalized}`
      const row = writers.get(key) ?? { kind: 'declared-shared-write', scope: entry.scope, path, packages: new Set() }
      row.packages.add(name)
      writers.set(key, row)
    }
  }
  return {
    declared,
    findings: [...writers.values()].filter(row => row.packages.size > 1)
      .map(row => ({ ...row, packages: [...row.packages].sort() })),
  }
}

function addPatch(layer, read, patches, rows, findings, limits, optional = false) {
  try {
    const text = read()
    patches.push({ layer, fingerprint: digest(text) })
    const document = parseDocument(text)
    if (document.errors.length || document.warnings.length) throw new Error('unsupported YAML')
    const entries = document.toJS({ maxAliasCount: 50 })
    if (entries === null) return
    if (!Array.isArray(entries)) throw new Error('expected a patch array')
    const add = (row, insertion) => {
      if (Array.isArray(row) && row.length === 0) return
      if (!isObject(row) || typeof row.id !== 'string' || !row.id ||
          Object.keys(row).some(key => ['insert', 'before', 'after', 'remove', 'include', 'plugins'].includes(key)) ||
          (Object.hasOwn(row, 'name') && typeof row.name !== 'string')) {
        limits.add('unsupported-patch-rows')
        return
      }
      const id = row.id
      const previous = rows.get(id)
      const config = Object.hasOwn(row, 'config') ? row.config : previous?.config
      if (insertion && previous?.insertedAt) {
        findings.push({ kind: 'duplicate-insert-id', id, layer, previousLayer: previous.insertedAt })
      }
      if (!insertion && previous) {
        const removedKeys = Object.hasOwn(row, 'config') && isObject(previous.config)
          ? Object.keys(previous.config).filter(key => !isObject(config) || !Object.hasOwn(config, key)).sort()
          : []
        const moduleChanged = typeof row.name === 'string' && previous.name !== undefined && row.name !== previous.name
        if (removedKeys.length || moduleChanged) {
          findings.push({
            kind: 'config-override', id, layer, previousLayer: removedKeys.length ? previous.configLayer : previous.nameLayer,
            removedKeys, moduleChanged,
          })
        }
      }
      rows.set(id, {
        name: row.name ?? previous?.name, config,
        nameLayer: row.name !== undefined ? layer : previous?.nameLayer,
        configLayer: Object.hasOwn(row, 'config') ? layer : previous?.configLayer,
        insertedAt: insertion ? layer : previous?.insertedAt,
      })
    }
    for (const row of entries) {
      if (isObject(row) && Object.keys(row).length === 1 && Array.isArray(row.insert)) {
        for (const inserted of row.insert) add(inserted, true)
      } else {
        add(row, false)
      }
    }
  } catch (error) {
    if (!(optional && error.code === 'ENOENT')) limits.add(`unreadable-patch:${layer}`)
  }
}

/**
 * Read the selected profile and a possible local package. Findings concern literal patch rows and
 * declarations. Loading, executing, or changing plugins is outside this report's scope.
 */
export function buildReliabilityReport({ home, profile, runtimeVersion, targetVersion, candidateDirectory, liveEntries } = {}) {
  if (targetVersion !== undefined && (typeof targetVersion !== 'string' || semver.valid(targetVersion) === null)) {
    throw new Error('target DSH version must be an exact semantic version')
  }
  const root = resolve(resolveDshHome(home))
  const profiles = listProfiles(root)
  const selected = profile ?? (profiles.includes('desktop') ? 'desktop' : profiles.includes('web') ? 'web' : profiles[0])
  if (!profiles.includes(selected)) throw new Error('DSH profile not found')
  const directory = join(root, 'profiles', selected)
  const currentVersion = semver.valid(runtimeVersion) ?? null
  const target = targetVersion ?? currentVersion
  const limits = new Set(['launch-overlays-not-read', 'tool-and-file-behavior-not-tested'])
  const profilePackage = readPackage(directory)
  const patches = [{ layer: 'profile manifest', fingerprint: profilePackage.fingerprint }]
  const packages = []
  const findings = []
  const rows = new Map()
  const manifests = new Map()
  let exemptions = {}
  try {
    const raw = readBoundedText(join(directory, EXEMPTION_FILE))
    patches.push({ layer: 'version exemptions', fingerprint: digest(raw) })
    const parsed = JSON.parse(raw)
    if (!isObject(parsed)) throw new Error('invalid exemption manifest')
    exemptions = Object.fromEntries(Object.entries(parsed).filter(([, versions]) => Array.isArray(versions)))
  } catch (error) {
    if (error.code !== 'ENOENT') limits.add('exemptions-unreadable')
  }
  for (const file of ['pnpm-lock.yaml', 'package-lock.json', 'pnpm-workspace.yaml']) {
    try {
      patches.push({ layer: file, fingerprint: digest(readBoundedText(join(directory, file), 8 * 1024 * 1024)) })
    } catch (error) {
      if (error.code !== 'ENOENT') limits.add(`unreadable-profile-file:${file}`)
    }
  }
  for (const entry of listInstalledPlugins(directory, profilePackage.manifest)) {
    if (!PACKAGE_NAME.test(entry.name)) {
      limits.add('unsupported-package-name')
      continue
    }
    let data
    try {
      data = readPackage(entry.directory)
      if (data.manifest.name !== entry.name || !semver.valid(data.manifest.version)) throw new Error('unverified package identity')
      manifests.set(entry.name, { ...data, directory: entry.directory })
    } catch {
      // In-box bundles are provided by the launcher and may be absent from this profile.
      limits.add(entry.name.startsWith('@deepseek-ai/') ? 'in-box-bundles-not-read' : 'unreadable-package')
      if (!entry.name.startsWith('@deepseek-ai/')) {
        packages.push({ name: entry.name, source: entry.source, version: null, declaration: { state: 'unknown' } })
      }
      continue
    }
    const coreCopy = HOST_PACKAGES.has(entry.name)
    if (coreCopy) findings.push({ kind: 'profile-host-package', name: entry.name, version: data.manifest.version })
    packages.push({
      name: entry.name, version: data.manifest.version, source: entry.source, fingerprint: data.fingerprint,
      declaration: entry.name.startsWith('@deepseek-ai/') ? { state: 'not-checked' } : declaration(data.manifest, target, exemptions),
    })
  }
  let candidate
  if (candidateDirectory !== undefined) {
    const data = readPackage(candidateDirectory)
    if (!PACKAGE_NAME.test(data.manifest.name ?? '') || !semver.valid(data.manifest.version)) {
      throw new Error('candidate must have a valid package name and exact version')
    }
    candidate = {
      name: data.manifest.name, version: data.manifest.version, source: 'candidate',
      fingerprint: data.fingerprint, declaration: declaration(data.manifest, target, {}),
    }
    manifests.set(candidate.name, { ...data, directory: candidateDirectory })
  }
  const bundles = profilePackage.manifest.dsh?.profile?.bundles
  const order = Array.isArray(bundles) ? [...bundles] : []
  if (candidate && !order.includes(candidate.name)) order.push(candidate.name)
  for (const name of new Set(order)) {
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) continue
    // The host always loads its in-box bundle patches from the installation, not from this copy.
    if (name.startsWith('@deepseek-ai/')) {
      limits.add('in-box-bundles-not-read')
      continue
    }
    const data = manifests.get(name)
    const declared = data?.manifest.dsh?.bundle?.patch
    const files = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]
    for (const [index, file] of files.entries()) {
      const layer = `${candidate?.name === name ? 'candidate' : 'bundle'} ${name} #${index + 1}`
      addPatch(layer, () => readBoundedText(bundlePatch(data.directory, file)), patches, rows, findings, limits)
    }
  }
  addPatch('profile patch', () => readBoundedText(join(directory, PATCH)), patches, rows, findings, limits, true)
  addPatch('home patch', () => readBoundedText(join(root, PATCH)), patches, rows, findings, limits, true)
  const resources = findDeclaredWriteOverlap(manifests, limits)
  findings.push(...resources.findings)
  const activation = Array.isArray(liveEntries) ? liveEntries : null
  return {
    schemaVersion: 1, profile: selected, capturedAt: new Date().toISOString(),
    currentVersion, targetVersion: target, packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
    patches, findings, candidate: candidate ?? null, activation,
    resourceDeclarations: resources.declared, limits: [...limits],
  }
}

export function compareReliabilityReports(before, after) {
  for (const report of [before, after]) {
    if (report?.schemaVersion !== 1 || typeof report.profile !== 'string' || report.candidate !== null ||
        !Array.isArray(report.packages) || !Array.isArray(report.patches) ||
        !report.packages.every(row => typeof row?.name === 'string') ||
        !report.patches.every(row => typeof row?.layer === 'string' && typeof row.fingerprint === 'string')) {
      throw new Error('expected a version 1 profile snapshot without a candidate')
    }
  }
  if (before.profile !== after.profile) throw new Error('snapshots must describe the same profile name')
  const compare = (left, right, key, fields) => {
    const old = new Map(left.map(row => [row[key], row]))
    const next = new Map(right.map(row => [row[key], row]))
    return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap(name => {
      const a = old.get(name)
      const b = next.get(name)
      if (a && b && fields.every(field => a[field] === b[field])) return []
      return [{ name, change: !a ? 'added' : !b ? 'removed' : 'changed', before: a?.version ?? null, after: b?.version ?? null }]
    })
  }
  return {
    profile: after.profile, before: before.capturedAt, after: after.capturedAt,
    host: { before: before.currentVersion, after: after.currentVersion },
    packages: compare(before.packages, after.packages, 'name', ['version', 'source', 'fingerprint']),
    patches: compare(before.patches, after.patches, 'layer', ['fingerprint']),
  }
}
