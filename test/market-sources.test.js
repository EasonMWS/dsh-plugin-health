import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addSource, listSources, removeSource } from '../src/outside/market-sources.js'

// The saved-source list is a convenience, which means it must never be the reason the page fails — but its
// labels are what the user clicks, so a percent-encoded path is a real defect: it says nothing.

function home() {
  return mkdtempSync(join(tmpdir(), 'sources-'))
}

/** A real file, because a local source is only accepted when it exists. */
function localIndex(dir, name = 'market.json') {
  const path = join(dir, name)
  writeFileSync(path, '{"format":1,"title":"x","plugins":[]}', 'utf8')
  return path
}

test('an empty list is returned for a home that has none', () => {
  const dir = home()
  try {
    assert.deepEqual(listSources(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a source can be added and read back', () => {
  const dir = home()
  try {
    const path = localIndex(dir)
    const added = addSource(dir, { url: path })
    assert.equal(added.ok, true, added.error)
    assert.equal(added.sources.length, 1)
    assert.equal(listSources(dir)[0].url, path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Windows path gets a readable label, not a percent-encoded URL', () => {
  // "D:\\x\\market.json" parses as a URL whose scheme is "d:", which produced "/agent%E5%A4%B4..." as a
  // label. A label nobody can read is a label nobody clicks.
  const dir = home()
  try {
    const path = localIndex(dir, 'market-windows.json')
    const added = addSource(dir, { url: path })
    assert.equal(added.ok, true, added.error)
    assert.equal(added.sources[0].label, 'market-windows.json')
    assert.equal(/%[0-9A-F]{2}/iu.test(added.sources[0].label), false, 'a label must not be percent-encoded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a URL gets its last path segment as the label, or its host when there is none', () => {
  const dir = home()
  try {
    const withPath = addSource(dir, { url: 'https://example.org/market/index.json' })
    assert.equal(withPath.sources[0].label, 'index.json')

    const root = addSource(dir, { url: 'https://example.org/' })
    assert.equal(root.sources[0].label, 'example.org')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adding the same source twice does not duplicate it', () => {
  const dir = home()
  try {
    const path = localIndex(dir)
    addSource(dir, { url: path })
    addSource(dir, { url: path })
    assert.equal(listSources(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a source that is neither a URL nor an existing file is refused', () => {
  const dir = home()
  try {
    const result = addSource(dir, { url: 'not-a-url-or-file' })
    assert.equal(result.ok, false)
    assert.match(result.error, /no such file/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty source is refused', () => {
  const dir = home()
  try {
    assert.equal(addSource(dir, { url: '   ' }).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a source can be removed', () => {
  const dir = home()
  try {
    const path = localIndex(dir)
    addSource(dir, { url: path })
    const removed = removeSource(dir, path)
    assert.equal(removed.ok, true)
    assert.equal(removed.sources.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed sources file yields an empty list rather than an error', () => {
  // This is a preference file. Refusing to show the page because it is broken would be the wrong trade.
  const dir = home()
  try {
    mkdirSync(join(dir, '.plugin-health'), { recursive: true })
    writeFileSync(join(dir, '.plugin-health', 'market-sources.json'), '{ broken', 'utf8')
    assert.deepEqual(listSources(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the list is capped so it stays a list', () => {
  const dir = home()
  try {
    for (let i = 0; i < 20; i += 1) {
      addSource(dir, { url: `https://example.org/${i}/index.json` })
    }
    assert.ok(listSources(dir).length <= 12, `expected at most 12, saw ${listSources(dir).length}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})