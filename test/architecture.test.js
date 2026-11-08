import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repository holds three things that could have been three repositories. Splitting them now would mean
// three CIs and three versions for a project with no users yet; not splitting them risks the boundary
// dissolving until the split is no longer mechanical.
//
// So the boundary is a test instead of a document. It costs nothing to run and it fails the moment a
// shortcut is taken.
//
//   core    src/state/**            neither half owns it; both depend on it
//   plugin  everything else in src/ what DSH loads
//   manager src/outside/**, bin/health-outside.js, desktop/**   the standalone app
//
// Rules:
//   plugin  -> manager : never. The plugin must not need the desktop app to exist.
//   core    -> manager : never. A shared foundation that depends on one of its users is not shared.
//   manager -> plugin  : only the three modules below. Any new one has to be added here deliberately.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The modules the manager is allowed to use from the plugin half. */
const MANAGER_MAY_USE = [
  'src/compat/evaluate.js', // the compatibility judgement; one implementation or it disagrees with itself
  'src/repair/inspect.js',  // reading a profile
  'src/rescue/boot.js',     // the disable/enable overlay write
]

/** Every .js/.cjs file under a directory. */
function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(path, found)
      continue
    }
    if (/\.(?:js|cjs|mjs)$/u.test(entry.name)) found.push(path)
  }
  return found
}

/** Static and dynamic relative imports in one file. */
function relativeImports(file) {
  const text = readFileSync(file, 'utf8')
  const found = []
  for (const pattern of [
    /^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gmu,
    /^\s*export\s[^'"]*['"](\.[^'"]+)['"]/gmu,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/gu,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[1])
  }
  // main.cjs builds its paths with join(ROOT, 'src', ...), so a plain import scan misses them.
  for (const match of text.matchAll(/join\(\s*ROOT\s*,\s*'src'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/gu)) {
    found.push(`../../../src/${match[1]}/${match[2]}`)
  }
  return found
}

/** Which part of the repository a file belongs to. */
function partOf(file) {
  const path = relative(ROOT, file).replace(/\\/gu, '/')
  if (path.startsWith('src/outside/') || path.startsWith('desktop/')) return 'manager'
  if (path === 'bin/health-outside.js') return 'manager'
  if (path.startsWith('src/state/')) return 'core'
  if (path.startsWith('src/')) return 'plugin'
  return 'other'
}

/** Resolve an import relative to its file, for the purpose of classifying it. */
function resolveTarget(file, specifier) {
  return join(file, '..', specifier)
}

const SOURCES = [
  ...walk(join(ROOT, 'src')),
  join(ROOT, 'bin', 'health-outside.js'),
  join(ROOT, 'desktop', 'main.cjs'),
]

test('the plugin half never imports the manager', () => {
  // The whole point of the split question: the plugin has to install into DSH and run there. If it ever
  // needs something from the desktop app, the two can no longer be released independently at all.
  const offenders = []
  for (const file of SOURCES) {
    if (partOf(file) !== 'plugin') continue
    for (const specifier of relativeImports(file)) {
      if (partOf(resolveTarget(file, specifier)) === 'manager') {
        offenders.push(`${relative(ROOT, file).replace(/\\/gu, '/')} -> ${specifier}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `the plugin imports the manager:\n  ${offenders.join('\n  ')}`)
})

test('the shared core never imports the manager', () => {
  // src/state is used by both halves. A foundation that depends on one of its users is not a foundation,
  // it is a piece of that user with a misleading name.
  const offenders = []
  for (const file of SOURCES) {
    if (partOf(file) !== 'core') continue
    for (const specifier of relativeImports(file)) {
      if (partOf(resolveTarget(file, specifier)) === 'manager') {
        offenders.push(`${relative(ROOT, file).replace(/\\/gu, '/')} -> ${specifier}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `the core imports the manager:\n  ${offenders.join('\n  ')}`)
})

test('the manager uses only the three declared modules from the plugin half', () => {
  // Any new dependency has to be added to MANAGER_MAY_USE deliberately. That is the difference between a
  // boundary and a habit.
  const used = new Set()
  for (const file of SOURCES) {
    if (partOf(file) !== 'manager') continue
    for (const specifier of relativeImports(file)) {
      const target = resolveTarget(file, specifier)
      if (partOf(target) !== 'plugin') continue
      // Compare without the extension, since imports name the file with it.
      const path = relative(ROOT, target).replace(/\\/gu, '/')
      used.add(path.endsWith('.js') || path.endsWith('.cjs') ? path : `${path}.js`)
    }
  }

  const undeclared = [...used].filter((path) => !MANAGER_MAY_USE.includes(path)).sort()
  assert.deepEqual(undeclared, [],
    `the manager depends on plugin modules that are not declared:\n  ${undeclared.join('\n  ')}\n`
    + `Add them to MANAGER_MAY_USE if that is intended.`)

  // And the declared list must not rot: every entry should still be used.
  const unused = MANAGER_MAY_USE.filter((path) => !used.has(path))
  assert.deepEqual(unused, [], `MANAGER_MAY_USE lists modules nothing imports any more: ${unused.join(', ')}`)
})

test('the manager does not reach into the DSH-facing plugin surface', () => {
  // These are the modules that only make sense inside the host: a settings panel, a slot registration, the
  // agent tool. Importing one from the standalone app would be the first real step towards needing Electron
  // in the plugin or the host in the app.
  const FORBIDDEN = ['src/ui', 'src/plugin.js', 'src/cli.js', 'src/index']
  const offenders = []
  for (const file of SOURCES) {
    if (partOf(file) !== 'manager') continue
    for (const specifier of relativeImports(file)) {
      const path = relative(ROOT, resolveTarget(file, specifier)).replace(/\\/gu, '/')
      if (FORBIDDEN.some((prefix) => path.startsWith(prefix))) {
        offenders.push(`${relative(ROOT, file).replace(/\\/gu, '/')} -> ${specifier}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `the manager imports the host-facing surface:\n  ${offenders.join('\n  ')}`)
})

test('the parts are what the boundary claims they are', () => {
  // A boundary test that silently classifies a new directory as "other" would pass while the thing it was
  // meant to watch drifted. This pins the classification itself.
  assert.equal(partOf(join(ROOT, 'src', 'outside', 'server.js')), 'manager')
  assert.equal(partOf(join(ROOT, 'src', 'state', 'shared.js')), 'core')
  assert.equal(partOf(join(ROOT, 'src', 'ui', 'client.js')), 'plugin')
  assert.equal(partOf(join(ROOT, 'bin', 'health-outside.js')), 'manager')
  assert.equal(partOf(join(ROOT, 'desktop', 'main.cjs')), 'manager')
  assert.equal(partOf(join(ROOT, 'src', 'plugin.js')), 'plugin')
})