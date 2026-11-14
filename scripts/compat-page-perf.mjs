// Measure the compatibility page the way a reader meets it: first-screen DOM size, and how long one filter
// takes over the full data. Targets from the C2 spec: < 8,000 nodes before interaction, < 100 ms per filter
// on 5,000 rows.
//
// Not part of `npm test`: it needs a browser. Dev-only dependency, installed outside the package:
//   npm install --prefix ../artifacts/ui-beta3-qa --ignore-scripts playwright-core@1.56.1
//   node scripts/compat-page-perf.mjs [compat-dir]
// With no directory it builds a synthetic 5,000-row site. DSH_QA_DEPS / DSH_SCREENSHOT_BROWSER override paths.
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeCompatSite } from '../src/compat/artifacts.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const deps = resolve(process.env.DSH_QA_DEPS ?? join(root, '../artifacts/ui-beta3-qa'))
const { chromium } = createRequire(join(deps, 'package.json'))('playwright-core')
const browserPath = process.env.DSH_SCREENSHOT_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function syntheticSite() {
  const host = '0.2.2-rc.1'
  const plugins = Array.from({ length: 5000 }, (_, index) => {
    const bad = index % 7 === 0
    return {
      name: `plugin-${String(index).padStart(5, '0')}`, version: '1.0.0', declared: 'engines',
      declaredRanges: { 'engines.dsh': bad ? '^0.1.0' : (index % 11 === 0 ? '0.2.1-rc.5 || 0.2.2-rc.1' : '>=0.2.0-0 <0.3.0-0') },
      publishedAt: '2026-10-01T00:00:00Z',
      results: { [host]: bad ? { compatible: false, requirements: { 'engines.dsh': '^0.1.0' }, fixHint: { reason: 'caret-zero', suggested: { 'engines.dsh': '>=0.1.0 <0.3.0-0' }, crossesLine: true, suggestion: true } } : { compatible: true } },
      summary: { compatible: bad ? 0 : 1, incompatible: bad ? 1 : 0, errors: 0 },
    }
  })
  const out = mkdtempSync(join(tmpdir(), 'dsh-compat-perf-'))
  writeCompatSite({ generatedAt: new Date().toISOString(), hosts: [host], hostRoles: { [host]: 'latest' }, plugins }, out, {})
  return out
}

const directory = process.argv[2] ? resolve(process.argv[2]) : syntheticSite()
if (!existsSync(join(directory, 'index.html'))) throw new Error(`${directory} has no index.html`)
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' }
const server = createServer((request, response) => {
  const path = normalize(join(directory, decodeURIComponent(new URL(request.url, 'http://x').pathname)))
  const file = path.endsWith('\\') || path.endsWith('/') ? join(path, 'index.html') : path
  if (!file.startsWith(directory) || !existsSync(file)) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
}).listen(0, '127.0.0.1')
await new Promise((ready) => server.once('listening', ready))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const html = readFileSync(join(directory, 'index.html'))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('#partial').waitFor({ state: 'hidden' })
  const total = await page.evaluate(() => JSON.parse(document.getElementById('i18n').textContent).data.total)
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length)
  const filterMs = await page.evaluate(async () => {
    const q = document.getElementById('q')
    const samples = []
    for (const needle of ['plugin-01', 'plugin-4', 'zzz', '']) {
      const start = performance.now()
      q.value = needle
      q.dispatchEvent(new Event('input'))
      samples.push(performance.now() - start)
    }
    return Math.max(...samples)
  })
  const rejectedFilterMs = await page.evaluate(() => {
    const select = document.getElementById('status')
    const start = performance.now()
    select.value = 'statusRejected'
    select.dispatchEvent(new Event('change'))
    return performance.now() - start
  })
  // A narrow screen must not scroll the page sideways.
  await page.setViewportSize({ width: 375, height: 800 })
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  const result = {
    rows: total,
    htmlBytes: html.length,
    firstScreenNodes: nodes,
    worstFilterMs: Math.round(filterMs * 10) / 10,
    statusFilterMs: Math.round(rejectedFilterMs * 10) / 10,
    phoneScrollsSideways: sideways,
    targets: { firstScreenNodes: '< 8000', filterMs: '< 100' },
  }
  console.log(JSON.stringify(result, null, 2))
  if (nodes >= 8000 || filterMs >= 100 || rejectedFilterMs >= 100 || sideways) process.exitCode = 1
} finally {
  await browser.close()
  server.close()
}
