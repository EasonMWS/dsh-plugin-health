// Regenerate the README screenshots from the real component tree.
//
// The section renders itself with inline style objects and literal colours, so it can be rebuilt
// faithfully outside a running host — only the React runtime is stubbed. Run:
//
//   node scripts/build-screenshots.js
//
// which writes docs/images/<name>.png (English) and docs/images/<name>.zh.png (Chinese).
import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('..', import.meta.url))

// Edge ships with Windows; allow an override for a machine where it lives elsewhere.
const edge = process.env.DSH_SCREENSHOT_BROWSER
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
if (!existsSync(edge)) throw new Error(`no browser at ${edge}; set DSH_SCREENSHOT_BROWSER`)

// `width`/`height` are chosen per state to fit the content exactly, so the image has no scrollbar
// and no trailing whitespace.
const SHOTS = [
  { state: 'finding', name: 'settings-finding', width: 728, height: 780 },
  { state: 'exempt', name: 'settings-exemption', width: 728, height: 700 },
  { state: 'sidebar', name: 'sidebar-alert', width: 268, height: 74 },
]

let made = 0
for (const { state, name, width, height } of SHOTS) {
  for (const lang of ['en', 'zh']) {
    const target = join(root, 'docs', 'images', lang === 'en' ? `${name}.png` : `${name}.zh.png`)
    const html = join(tmpdir(), `dsh-shot-${state}-${lang}.html`)
    const png = join(tmpdir(), `dsh-shot-${state}-${lang}.png`)

    execFileSync(process.execPath, ['scripts/render-screenshots.js', state, lang, html], { cwd: root, stdio: 'inherit' })
    if (existsSync(png)) unlinkSync(png)

    execFileSync(edge, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      `--user-data-dir=${join(tmpdir(), `edge-dsh-shot-${lang}`)}`,
      `--window-size=${width},${height}`,
      `--screenshot=${png}`,
      `file:///${html.replace(/\\/g, '/')}`,
    ], { stdio: 'ignore' })

    if (!existsSync(png)) throw new Error(`no screenshot produced for ${state}/${lang}`)
    execFileSync(process.execPath, ['-e', `
      require('node:fs').copyFileSync(${JSON.stringify(png)}, ${JSON.stringify(target)})
    `], { stdio: 'inherit' })
    console.log(`  ${name}${lang === 'zh' ? '.zh' : ''}.png  ${Math.round(statSync(target).size / 1024)}KB`)
    made += 1
  }
}

console.log(`\n  ${made} screenshots written to docs/images/`)