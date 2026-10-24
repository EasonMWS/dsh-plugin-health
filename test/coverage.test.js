import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listInstalledPlugins } from '../src/repair/inspect.js'

/**
 * A profile can pull plugins in three ways that `dsh.profile.bundles` alone does not describe:
 * the bundle list, a `cordis.patch.yml` insert, and plain `node_modules` entries. Reporting only the
 * bundle list makes the health check claim "clean" while a broken plugin sits beside it.
 */
function makeProfile({ bundles = [], dependencies = {}, patch, packages = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-coverage-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'profile',
    dsh: { profile: { bundles } },
    dependencies,
  }))
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  for (const name of packages) {
    const target = join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  return dir
}

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

test('lists bundles even when nothing else is installed', () => {
  const dir = makeProfile({ bundles: ['dsh-a', 'dsh-b'], packages: ['dsh-a', 'dsh-b'] })
  try {
    const names = listInstalledPlugins(dir, manifestOf(dir)).map((item) => item.name)
    assert.deepEqual(names.sort(), ['dsh-a', 'dsh-b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finds plugins that only appear in cordis.patch.yml', () => {
  const patch = [
    '# comment',
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '  config:',
    '    transcriptView: standard',
    '- id: extra',
    '  insert:',
    '    - name: dsh-only-in-patch',
    '      config: {}',
    '',
  ].join('\n')
  const dir = makeProfile({
    bundles: ['dsh-bundle'],
    patch,
    packages: ['dsh-bundle', 'dsh-only-in-patch', '@deepseek-ai/dsh-client-ui-chat'],
  })
  try {
    const list = listInstalledPlugins(dir, manifestOf(dir))
    const names = list.map((item) => item.name)
    assert.ok(names.includes('dsh-only-in-patch'), 'nested insert entry should be covered')
    assert.ok(names.includes('@deepseek-ai/dsh-client-ui-chat'), 'top-level patch entry should be covered')
    assert.equal(list.find((item) => item.name === 'dsh-only-in-patch').source, 'patch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finds plugins present in node_modules but absent from bundles', () => {
  const dir = makeProfile({ bundles: ['dsh-bundle'], packages: ['dsh-bundle', 'dsh-orphan'] })
  try {
    const names = listInstalledPlugins(dir, manifestOf(dir)).map((item) => item.name)
    assert.ok(names.includes('dsh-orphan'), 'a plugin installed without being declared must still be checked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('de-duplicates a plugin reachable several ways', () => {
  const patch = '- id: x\n  name: dsh-bundle\n'
  const dir = makeProfile({ bundles: ['dsh-bundle'], dependencies: { 'dsh-bundle': '1.0.0' }, patch, packages: ['dsh-bundle'] })
  try {
    const list = listInstalledPlugins(dir, manifestOf(dir))
    assert.equal(list.filter((item) => item.name === 'dsh-bundle').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('survives a malformed patch file', () => {
  const dir = makeProfile({ bundles: ['dsh-a'], patch: 'not: [valid', packages: ['dsh-a'] })
  try {
    const names = listInstalledPlugins(dir, manifestOf(dir)).map((item) => item.name)
    assert.deepEqual(names, ['dsh-a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
