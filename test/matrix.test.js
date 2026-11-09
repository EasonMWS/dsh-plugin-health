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

test('B6: every row says where its claim comes from, with the ranges, including rows that pass', async () => {
  const { declarationOf } = await import('../src/compat/matrix.js')
  assert.deepEqual(declarationOf({ engines: { dsh: '>=0.2.0-0' }, peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0' } }),
    { declared: 'engines', declaredRanges: { 'engines.dsh': '>=0.2.0-0' } }, 'engines decides alone, like the host')
  assert.deepEqual(declarationOf({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0', react: '^18' } }),
    { declared: 'peers', declaredRanges: { '@deepseek-ai/dsh-tools': '^0.1.0' } })
  assert.deepEqual(declarationOf({ peerDependencies: { react: '^18' } }), { declared: 'none', declaredRanges: {} })
  const matrix = evaluateMatrix([
    { name: 'plugin-good', version: '1.0.0', manifest: PACKUMENTS['plugin-good'].versions['1.0.0'] },
    { name: 'plugin-bad', version: '2.0.0', manifest: PACKUMENTS['plugin-bad'].versions['2.0.0'] },
    { name: 'plugin-quiet', version: '1.0.0', manifest: { name: 'plugin-quiet', version: '1.0.0' } },
  ], HOSTS)
  assert.deepEqual(matrix.plugins.map((row) => row.declared), ['engines', 'peers', 'none'])
  assert.equal(matrix.plugins[2].results[HOSTS[0]].compatible, true, 'undeclared passes the gate — the page must not call it verified')
  assert.equal(matrix.tool.name, 'dsh-plugin-health')
})

test('B6: fixHint explains ^0.x and suggests a range that admits the host, marked as a suggestion', async () => {
  const { fixHintFor } = await import('../src/compat/matrix.js')
  const caret = fixHintFor({ '@deepseek-ai/dsh-settings': '^0.1.0-rc.6' }, '0.2.2-rc.1')
  assert.equal(caret.reason, 'caret-zero')
  assert.equal(caret.suggestion, true)
  assert.deepEqual(caret.suggested, { '@deepseek-ai/dsh-settings': '>=0.1.0-rc.6 <0.3.0-0' })
  const enumerated = fixHintFor({ 'engines.dsh': '0.2.1-rc.4 || 0.2.1-rc.5' }, '0.2.2-rc.1')
  assert.equal(enumerated.reason, 'range-excludes-host')
  assert.deepEqual(enumerated.suggested, { 'engines.dsh': '>=0.2.1-rc.4 <0.3.0-0' })
  assert.equal(fixHintFor({ 'engines.dsh': '>=0.3.0' }, '0.2.2-rc.1'), undefined, 'no hint when the floor is above the host: that is not a stale range')
  assert.equal(fixHintFor({ '@deepseek-ai/dsh': 'workspace:^' }, '0.2.2-rc.1'), undefined)
  // A matrix row carries it only where the host is rejected.
  const matrix = evaluateMatrix([{ name: 'plugin-bad', version: '2.0.0', manifest: PACKUMENTS['plugin-bad'].versions['2.0.0'] }], ['0.2.1-rc.2'])
  assert.equal(matrix.plugins[0].results['0.2.1-rc.2'].fixHint.reason, 'caret-zero')
  const passing = evaluateMatrix([{ name: 'plugin-good', version: '1.0.0', manifest: PACKUMENTS['plugin-good'].versions['1.0.0'] }], ['0.2.1-rc.2'])
  assert.equal(Object.hasOwn(passing.plugins[0].results['0.2.1-rc.2'], 'fixHint'), false)
})

test('B6: a hint that crosses a host line says so, because the plugin never ran on that line', async () => {
  const { fixHintFor } = await import('../src/compat/matrix.js')
  assert.equal(fixHintFor({ 'engines.dsh': '0.2.1-rc.5' }, '0.2.2-rc.1').crossesLine, false)
  const old = fixHintFor({ '@deepseek-ai/dsh-llm': '^0.1.2-rc.1' }, '0.2.2-rc.1')
  assert.equal(old.crossesLine, true)
  assert.match(old.note, /check that it boots on 0\.2/u)
})

test('C3: a GitHub-only plugin is judged from its default-branch package.json and says so', async () => {
  const seen = []
  const loadGithubManifest = async (owner, repo) => {
    seen.push(`${owner}/${repo}`)
    if (repo === 'missing') throw new Error('HTTP 404')
    return { name: `gh-${repo}`, version: '0.3.0', engines: { dsh: '^0.1.0' } }
  }
  const [plugin] = await resolvePlugins(['github:someone/thing'], { loadGithubManifest })
  assert.equal(plugin.source, 'github')
  assert.equal(plugin.name, 'gh-thing')
  assert.equal(plugin.repositoryUrl, 'https://github.com/someone/thing')
  const matrix = await createMatrix({ plugins: ['github:someone/thing', 'github:someone/missing', 'plugin-good'], hosts: ['0.2.1-rc.2'], loadPackument, loadGithubManifest })
  assert.deepEqual(matrix.plugins.map((row) => row.source), ['github', 'npm'], 'order is kept, and a repository with no package.json is not counted')
  assert.equal(matrix.plugins[0].repository, 'https://github.com/someone/thing')
  assert.equal(matrix.plugins[0].results['0.2.1-rc.2'].compatible, false)
  const npmFailure = await createMatrix({ plugins: ['no-such-plugin'], hosts: ['0.2.1-rc.2'], loadPackument })
  assert.equal(npmFailure.plugins[0].source, 'unknown', 'an npm lookup that fails is still shown: that plugin was catalogued as published')
  await assert.rejects(resolvePlugins(['github:a/b'], { loadGithubManifest: async () => ({ private: true }) }), /no package\.json with a name and version/u)
})

test('createMatrix actually uses its concurrency', async () => {
  let inFlight = 0
  let peak = 0
  const slow = async (registry, name) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    inFlight -= 1
    return name === '@deepseek-ai/dsh' ? PACKUMENTS[name] : { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0' } } }
  }
  await createMatrix({ plugins: Array.from({ length: 12 }, (_, index) => `p${index}`), hosts: ['0.2.1-rc.2'], loadPackument: slow, concurrency: 4 })
  assert.equal(peak, 4)
})
