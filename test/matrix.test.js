import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMatrix, evaluateMatrix, hostSummary, parsePluginSpec, resolvePlugins } from '../src/compat/matrix.js'
import { matrixToMarkdown, writeBadges } from '../src/compat/report.js'

const HOSTS = ['0.2.1-rc.2', '0.2.0-rc.2']
const PACKUMENTS = {
  '@deepseek-ai/dsh': { 'dist-tags': { latest: '0.2.1-rc.2' }, versions: {} },
  'plugin-good': {
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: 'plugin-good', version: '1.0.0', engines: { dsh: '>=0.2.0-rc.2' }, repository: { url: 'git+https://github.com/example/plugin-good.git' } } },
  },
  'plugin-bad': {
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { name: 'plugin-bad', version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0' } } },
  },
}

const loadPackument = async (registry, name) => {
  const packument = PACKUMENTS[name]
  if (packument === undefined) throw new Error(`unknown package ${name}`)
  return packument
}

test('parsePluginSpec handles scoped names and versions', () => {
  assert.deepEqual(parsePluginSpec('dsh-market'), { name: 'dsh-market' })
  assert.deepEqual(parsePluginSpec('dsh-market@1.2.3'), { name: 'dsh-market', version: '1.2.3' })
  assert.deepEqual(parsePluginSpec('@scope/plugin@0.2.0-rc.1'), { name: '@scope/plugin', version: '0.2.0-rc.1' })
  assert.deepEqual(parsePluginSpec('@scope/plugin'), { name: '@scope/plugin' })
})

test('createMatrix resolves dist-tags and evaluates every host', async () => {
  const matrix = await createMatrix({
    plugins: ['plugin-good', 'plugin-bad'],
    hosts: ['latest', '0.2.0-rc.2'],
    loadPackument,
  })
  assert.deepEqual(matrix.hosts, HOSTS)
  assert.equal(matrix.plugins.length, 2)
  const good = matrix.plugins.find((plugin) => plugin.name === 'plugin-good')
  assert.equal(good.results['0.2.0-rc.2'].compatible, true)
  assert.equal(good.results['0.2.1-rc.2'].compatible, true)
  const bad = matrix.plugins.find((plugin) => plugin.name === 'plugin-bad')
  assert.equal(bad.results['0.2.1-rc.2'].compatible, false)
  assert.deepEqual(bad.results['0.2.1-rc.2'].requirements, { '@deepseek-ai/dsh-settings': '^0.1.0' })
  assert.deepEqual(hostSummary(matrix)[0], { host: '0.2.1-rc.2', compatible: 1, incompatible: 1, errors: 0, total: 2 })
})

test('evaluateMatrix reports manifest errors per host', () => {
  const matrix = evaluateMatrix([
    { name: 'broken', version: '1.0.0', manifest: { name: 'broken', version: '1.0.0', engines: { dsh: 7 } } },
  ], ['0.2.1-rc.2'])
  assert.equal(matrix.plugins[0].results['0.2.1-rc.2'].compatible, null)
  assert.match(matrix.plugins[0].results['0.2.1-rc.2'].error, /engines\.dsh must be a string/u)
})

test('markdown and badges are generated', async () => {
  const matrix = await createMatrix({ plugins: ['plugin-good', 'plugin-bad'], hosts: ['0.2.1-rc.2'], loadPackument })
  const markdown = matrixToMarkdown(matrix)
  assert.match(markdown, /plugin-good/u)
  assert.match(markdown, /✅/u)
  assert.match(markdown, /❌/u)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-badges-'))
  try {
    const written = writeBadges(matrix, directory)
    assert.ok(written.files.length >= 3)
    const svg = readFileSync(written.files[0], 'utf8')
    assert.match(svg, /<svg/u)
    assert.match(svg, /dsh compat/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('resolvePlugins reads a local plugin directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-local-'))
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.2.3', engines: { dsh: '>=0.2.0-rc.2' } }))
    const [plugin] = await resolvePlugins(['.'], { cwd: directory })
    assert.equal(plugin.source, 'local')
    assert.equal(plugin.name, 'local-plugin')
    assert.equal(plugin.version, '1.2.3')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
