import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import {
  buildFormat1Index,
  healthScore,
  normalizeLocalized,
  normalizeRepository,
  selectedVersions,
} from '../src/index/build.js'
import { compatibilityLookup } from '../src/index/catalog.js'

const CATALOG = {
  name: 'fixture',
  count: 3,
  updated: '2026-10-17',
  categories: {
    tools: { en: 'Tools', zh: '工具' },
    theme: { en: 'Themes', zh: '主题' },
  },
  plugins: [
    {
      name: 'good-plugin',
      npm: 'good-plugin',
      owner: 'example',
      category: 'tools',
      description: { en: 'A useful plugin.', zh: '一个好用的插件。' },
      url: 'https://github.com/example/good-plugin',
      stars: 42,
      downloads: 12345,
      capabilities: ['fs-read'],
      capabilityRedLines: [],
    },
    {
      name: 'git-only',
      npm: null,
      owner: 'another',
      category: 'theme',
      description: { en: 'GitHub only.', zh: '只有 GitHub。' },
      url: 'https://github.com/another/git-only',
      stars: 1,
      downloads: 0,
    },
    {
      name: 'missing-npm',
      npm: 'missing-npm',
      owner: 'nobody',
      category: 'tools',
      description: 'A plugin that cannot be fetched.',
      stars: 0,
      downloads: 2,
    },
  ],
}

const PACKUMENT = {
  'dist-tags': { latest: '1.2.0' },
  time: {
    '1.0.0': '2026-08-01T00:00:00.000Z',
    '1.1.0': '2026-09-01T00:00:00.000Z',
    '1.2.0': '2026-10-01T00:00:00.000Z',
  },
  versions: {
    '1.0.0': { name: 'good-plugin', version: '1.0.0', engines: { dsh: '>=0.1.0' } },
    '1.1.0': { name: 'good-plugin', version: '1.1.0', engines: { dsh: '>=0.2.0-rc.1' } },
    '1.2.0': {
      name: 'good-plugin',
      version: '1.2.0',
      homepage: 'https://example.com/good-plugin#readme',
      repository: { url: 'git+https://github.com/example/good-plugin.git' },
      engines: { dsh: '>=0.2.0-rc.2' },
    },
  },
}

async function fixtureCatalog() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-health-index-'))
  const file = join(directory, 'catalog.json')
  writeFileSync(file, JSON.stringify(CATALOG))
  return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

const loadPackument = async (registry, name) => {
  if (name === 'good-plugin') return PACKUMENT
  throw new Error(`no such package: ${name}`)
}

const MATRIX = {
  hosts: ['0.2.1-rc.2'],
  plugins: [{ name: 'good-plugin', version: '1.2.0', results: { '0.2.1-rc.2': { compatible: true } } }],
}

test('normalizeLocalized requires and keeps an English fallback', () => {
  assert.equal(normalizeLocalized('plain'), 'plain')
  assert.deepEqual(normalizeLocalized({ en: 'Hello', zh: '你好' }), { en: 'Hello', zh: '你好' })
  assert.deepEqual(normalizeLocalized({ zh: '你好' }), { zh: '你好', en: '你好' })
  assert.equal(normalizeLocalized({ EN: 'nope' }), undefined)
  assert.equal(normalizeLocalized(42), undefined)
})

test('normalizeRepository strips git prefixes, tree paths and fragments', () => {
  assert.deepEqual(normalizeRepository({ repository: 'git+https://github.com/example/good-plugin.git' }), { url: 'https://github.com/example/good-plugin' })
  assert.deepEqual(normalizeRepository({}, { url: 'https://github.com/example/repo/tree/main/packages/plugin' }), { url: 'https://github.com/example/repo' })
  assert.deepEqual(normalizeRepository({ repository: { url: 'https://github.com/example/mono', directory: 'packages/plugin' } }), { url: 'https://github.com/example/mono', directory: 'packages/plugin' })
  assert.equal(normalizeRepository({ repository: 'git+ssh://git@github.com/example/x.git' }), undefined)
})

test('selectedVersions puts latest first and validates timestamps', () => {
  const versions = selectedVersions(PACKUMENT, 2)
  assert.deepEqual(versions.map((entry) => entry.version), ['1.2.0', '1.1.0'])
  assert.deepEqual(versions[0].source, { type: 'npm' })
  assert.deepEqual(versions[0].engines, { dsh: '>=0.2.0-rc.2' })
  assert.ok(Number.isInteger(versions[0].publishTimestamp))
})

test('healthScore is bounded and rewards popularity and compatibility', () => {
  const low = healthScore({ downloads: 0, stars: 0, compatible: false })
  const high = healthScore({ downloads: 1_000_000, stars: 10_000, compatible: true })
  const risky = healthScore({ downloads: 1_000_000, stars: 10_000, compatible: true, risk: true })
  assert.ok(low >= 0 && low <= 100)
  assert.ok(high > low)
  assert.equal(high - risky, 10)
})

test('compatibilityLookup maps package names to the chosen host', () => {
  const lookup = compatibilityLookup(MATRIX, '0.2.1-rc.2')
  assert.equal(lookup('good-plugin'), true)
  assert.equal(lookup('unknown'), undefined)
})

test('buildFormat1Index produces an official format-1 document', async () => {
  const { file, cleanup } = await fixtureCatalog()
  try {
    const build = await buildFormat1Index({
      catalog: file,
      hostVersion: '0.2.1-rc.2',
      indexUrl: 'https://example.com/index.json',
      limit: 10,
      maxVersions: 2,
      loadPackument,
      matrix: MATRIX,
    })
    assert.equal(build.doc.format, 1)
    assert.equal(build.stats.included, 1)
    assert.equal(build.stats.gitOnlySkipped, 1)
    assert.equal(build.stats.failed, 1)
    const plugin = build.doc.plugins[0]
    assert.equal(plugin.name, 'good-plugin')
    assert.equal(plugin.metadata.category, 'tools')
    assert.ok(plugin.metadata.labels.includes('compatible'))
    assert.ok(plugin.metadata.labels.includes('npm'))
    assert.deepEqual(plugin.metadata.sortKeys.downloads, 12345)
    assert.equal(plugin.versions.length, 2)
    const parsed = parseMarketIndex(build.doc, 'https://example.com/index.json')
    assert.equal(parsed.plugins.length, 1)
    assert.equal(parsed.plugins[0].metadata.category, 'tools')
  } finally {
    cleanup()
  }
})

test('invalid index documents are rejected by the official parser', async () => {
  const { file, cleanup } = await fixtureCatalog()
  try {
    const build = await buildFormat1Index({
      catalog: file, hostVersion: '0.2.1-rc.2', indexUrl: 'https://example.com/index.json', limit: 10, loadPackument,
    })
    const broken = { ...build.doc, title: { zh: '只有中文' } }
    assert.throws(() => parseMarketIndex(broken, 'https://example.com/index.json'), /must contain en/u)
  } finally {
    cleanup()
  }
})
