// Real React and browser rendering of the shipped client entry with synthetic host data.
// This is component/HTTP-fixture acceptance, not native DSH desktop acceptance.
// Install dev-only dependencies outside the published package, then run:
// npm install --prefix ../artifacts/ui-beta3-qa --ignore-scripts react@18.3.1 react-dom@18.3.1 playwright-core@1.56.1
// node scripts/browser-qa.mjs
// DSH_QA_DEPS / DSH_QA_OUTPUT / DSH_SCREENSHOT_BROWSER optionally override local paths.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uiSnapshot } from './fixtures/ui-snapshot.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const deps = resolve(process.env.DSH_QA_DEPS ?? join(root, '../artifacts/ui-beta3-qa'))
const out = resolve(process.env.DSH_QA_OUTPUT ?? join(root, '../artifacts/dsh-plugin-health-beta/verification-beta.4'))
const requireDev = createRequire(join(deps, 'package.json'))
const { chromium } = requireDev('playwright-core')
const edge = process.env.DSH_SCREENSHOT_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
mkdirSync(out, { recursive: true })

const harness = `
  const dictionary = new Map(), sections = new Map(), disposers = [];
  const language = new URLSearchParams(location.search).get('lang') || 'zh';
  const translate = ns => (key, values = {}) => (dictionary.get(ns)?.[language]?.[key] || dictionary.get(ns)?.en?.[key] || key)
    .replace(/\\{(\\w+)\\}/g, (match, name) => values[name] ?? match);
  const ctx = {
    locale: { register(ns, values) { dictionary.set(ns, values); }, bind: translate },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject(names, fn) { const dispose = fn(ctx); if (typeof dispose === 'function') disposers.push(dispose); },
    get() { return undefined; },
    slots: {
      inject(_name, fn) { return fn(); },
      register(meta, component) { sections.set(meta.id, { meta, component }); return () => sections.delete(meta.id); },
    },
  };
  window.__ModuleLoader__ = { load({ factory }) {
    const client = factory(name => { if (name !== 'react') throw new Error('Unexpected module: ' + name); return React; });
    client.apply(ctx);
    const { meta, component } = sections.get('plugin-health');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(component, { t: translate(meta.locale) }));
  }};
`
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Plugin health component QA</title><style>
    :root { color-scheme: light dark; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { margin: 0; padding: 20px; background: light-dark(#fafbfc,#171a20); color: light-dark(#222a35,#e5e9ef); }
    #root { max-width: 900px; margin: 0 auto; }
    @media (max-width:520px) { body { padding: 12px; } }
  </style></head><body><main id="root"></main>
  <script src="/react.js"></script><script src="/react-dom.js"></script>
  <script>${harness}</script><script src="/client.js"></script></body></html>`
const assets = new Map([
  ['/react.js', join(dirname(requireDev.resolve('react/package.json')), 'umd/react.development.js')],
  ['/react-dom.js', join(dirname(requireDev.resolve('react-dom/package.json')), 'umd/react-dom.development.js')],
  ['/client.js', join(root, 'src/ui/client.js')],
])
const requests = [], checks = [], errors = [], warnings = []
let allowScriptedRepair = false
let allowScriptedRescue = false
const clientSource = readFileSync(join(root, 'src/ui/client.js'), 'utf8')
const sourceSha256 = createHash('sha256').update(clientSource).digest('hex')
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const request = { method: req.method, path: url.pathname, query: url.search }
  requests.push(request)
  if (url.pathname === '/plugins/dsh-plugin-health/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(uiSnapshot(url.searchParams.get('target') ?? undefined, { withRescue: allowScriptedRescue })))
  } else if (allowScriptedRepair && req.method === 'POST' && url.pathname === '/plugins/dsh-plugin-health/repair') {
    // Fixture responses only; this test server never invokes the actual repair route or filesystem operations.
    let body = ''
    for await (const chunk of req) body += chunk
    request.body = JSON.parse(body)
    const result = request.body.dryRun ? {
      planned: [{ id: 'bundle-manifest-invalid', description: 'Quarantine the synthetic broken directory' }],
      manual: 0, planToken: 'qa-plan-token',
    } : { actions: [{ kind: 'quarantine', from: 'C:\\DSH\\synthetic-broken' }], quarantineDir: 'C:\\DSH\\synthetic-quarantine' }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result))
  } else if (allowScriptedRescue && req.method === 'POST' && url.pathname === '/plugins/dsh-plugin-health/rescue/rehearse') {
    // No plugin is installed or executed. This tests frontend consent and per-card state only.
    let body = ''
    for await (const chunk of req) body += chunk
    request.body = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ verdict: 'runs', canApply: true, hostVersion: '0.2.1-rc.3' }))
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html)
  } else if (assets.has(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(assets.get(url.pathname)))
  } else if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end() }
  else { res.writeHead(404); res.end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
let browser
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`) }
async function screenshot(page, name) { await page.screenshot({ path: join(out, name), fullPage: true, animations: 'disabled' }) }
try {
  browser = await chromium.launch({ executablePath: edge, headless: true })
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
    if (message.type() === 'warning') warnings.push(message.text())
  })
  await page.goto(origin)
  const panel = page.locator('.dph-panel')
  await page.getByText('插件文件损坏', { exact: true }).waitFor()
  await check('daily mode is the default and exposes current failures', async () => {
    assert.equal(await panel.getAttribute('data-view'), 'daily')
    assert.equal(await page.getByText('插件文件损坏', { exact: true }).isVisible(), true)
    assert.match(await panel.innerText(), /search_notes/)
    assert.equal(await page.getByRole('button', { name: '下载运行证据', exact: true }).count(), 0)
    assert.match(await panel.innerText(), /启动状态（加载条目）/)
    assert.match(await panel.innerText(), /功能名称「search_notes」被重复使用/)
    // The counters are visible in daily mode by design. The technical wording is not.
    assert.match(await panel.innerText(), /运行中/)
    assert.doesNotMatch(await panel.innerText(), /宿主加载状态|node_modules|package\.json/)
  })
  const detail = page.getByRole('button', { name: /插件文件损坏/ })
  await check('Enter expands findings and Space collapses with focus preserved', async () => {
    await detail.focus(); await page.keyboard.press('Enter')
    assert.equal(await detail.getAttribute('aria-expanded'), 'true')
    const id = await detail.getAttribute('aria-controls')
    assert.equal(await page.locator(`[id="${id}"]`).getAttribute('aria-hidden'), 'false')
    await page.keyboard.press('Space')
    assert.equal(await detail.getAttribute('aria-expanded'), 'false')
    assert.equal(await detail.evaluate(node => node === document.activeElement), true)
    assert.equal(await page.locator(`[id="${id}"]`).evaluate(node => node.inert), true)
  })
  await check('collapse has height and opacity transitions', async () => {
    const css = await page.locator('.dph-collapse').first().evaluate(node => {
      const style = getComputedStyle(node); return { duration: style.transitionDuration, property: style.transitionProperty }
    })
    assert.match(css.property, /grid-template-rows/)
    assert.ok(css.duration.split(',').some(value => parseFloat(value) > 0))
  })
  await check('opening details animates through an intermediate height', async () => {
    const heights = await detail.evaluate(async node => {
      const body = document.getElementById(node.getAttribute('aria-controls'))
      await Promise.all(body.getAnimations().map(animation => animation.finished))
      const before = body.getBoundingClientRect().height
      node.click()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const midway = body.getBoundingClientRect().height
      await Promise.all(body.getAnimations().map(animation => animation.finished))
      const after = body.getBoundingClientRect().height
      return { before, midway, after }
    })
    assert.ok(heights.before < heights.midway && heights.midway < heights.after, JSON.stringify(heights))
    await detail.click()
  })
  await check('daily findings explain the next step while technical paths need a separate disclosure', async () => {
    await detail.click()
    assert.match(await panel.innerText(), /安装信息读不出来/)
    assert.doesNotMatch(await panel.innerText(), /node_modules|package\.json/)
    const diagnostic = page.getByRole('button', { name: '查看详细信息', exact: true })
    assert.equal(await diagnostic.getAttribute('aria-expanded'), 'false')
    await diagnostic.click()
    await page.waitForFunction(() => document.querySelector('.dph-panel').innerText.includes('node_modules'))
    assert.match(await panel.innerText(), /package\.json/)
    await diagnostic.click(); await detail.click()
  })
  await screenshot(page, 'settings-daily.zh.png')
  const modeButtons = page.getByRole('group', { name: '显示模式' })
  const modeButton = mode => modeButtons.getByRole('button', {
    name: { daily: '日常检查', advanced: '进阶诊断', developer: '开发验证' }[mode], exact: true,
  })
  const selectMode = mode => modeButton(mode).click()
  await check('mode buttons work with Enter and Space and announce their selection', async () => {
    assert.equal(await modeButton('daily').getAttribute('aria-pressed'), 'true')
    await modeButton('advanced').focus()
    await page.keyboard.press('Enter')
    assert.equal(await panel.getAttribute('data-view'), 'advanced')
    assert.equal(await modeButton('advanced').getAttribute('aria-pressed'), 'true')
    assert.equal(await modeButton('daily').getAttribute('aria-pressed'), 'false')
    await modeButton('daily').focus()
    await page.keyboard.press('Space')
    assert.equal(await panel.getAttribute('data-view'), 'daily')
  })
  await check('refresh timing is exposed on keyboard focus', async () => {
    const tip = panel.locator('.dph-scan-tip')
    assert.equal(await tip.isVisible(), false)
    const rescan = page.getByRole('button', { name: '重新扫描', exact: true })
    await rescan.focus()
    assert.equal(await tip.isVisible(), true)
    assert.match(await tip.innerText(), /每 30 秒.*状态更新时间/)
    await modeButton('daily').focus()
    assert.equal(await tip.isVisible(), false)
  })
  await check('all three modes visibly state the malware-protection limit', async () => {
    for (const mode of ['daily', 'advanced', 'developer']) {
      await selectMode(mode)
      assert.equal(await panel.locator('footer').getByText('检查安装和启动状态。Health 无法查杀病毒或阻止恶意程序扩散。', { exact: true }).isVisible(), true)
    }
  })
  await selectMode('advanced')
  await check('advanced mode reveals version preflight and preserves a typed target across modes', async () => {
    assert.equal(await panel.getAttribute('data-view'), 'advanced')
    assert.match(await panel.innerText(), /启动状态（加载条目）/)
    const input = page.getByLabel('准备升级到的 DSH 版本')
    await input.fill('0.2.1-rc.5')
    await selectMode('daily'); await selectMode('advanced')
    assert.equal(await input.inputValue(), '0.2.1-rc.5')
    await page.getByRole('button', { name: '检查升级影响', exact: true }).click()
    await page.getByText(/^DSH 0\.2\.1-rc\.5 · 已判定声明：\d+ 个包 · 声明不匹配且未放行：1 个包$/).waitFor()
    assert.ok(requests.some(row => row.query.includes('target=0.2.1-rc.5')))
  })
  await check('completed preflight and expanded inventory survive switching through daily mode', async () => {
    const inventory = page.getByRole('button', { name: /当前环境的包清单/ })
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button[aria-expanded]'))
      .some(node => node.textContent.includes('当前环境的包清单') && node.getAttribute('aria-expanded') === 'true'))
    await selectMode('daily'); await selectMode('advanced')
    assert.equal(await page.getByText(/^DSH 0\.2\.1-rc\.5 · 已判定声明：\d+ 个包 · 声明不匹配且未放行：1 个包$/).isVisible(), true)
    assert.equal(await inventory.getAttribute('aria-expanded'), 'true')
  })
  await screenshot(page, 'settings-advanced.zh.png')
  await selectMode('developer')
  await check('developer mode exposes commands and evidence download', async () => {
    assert.equal(await panel.getAttribute('data-view'), 'developer')
    assert.match(await panel.innerText(), /启动状态（加载条目）/)
    assert.match(await panel.innerText(), /dsh-plugin-health smoke/)
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载运行证据', exact: true }).click()
    const download = await downloaded
    const parsed = JSON.parse(readFileSync(await download.path(), 'utf8'))
    assert.equal(parsed.profile, 'desktop')
    assert.equal(parsed.entries.some(entry => entry.state === 'failed'), true)
    assert.equal(Object.hasOwn(parsed, 'key'), false)
  })
  await screenshot(page, 'settings-developer.zh.png')
  await check('selected mode persists after reload', async () => {
    await page.reload(); await page.getByText('插件文件损坏', { exact: true }).waitFor()
    assert.equal(await panel.getAttribute('data-view'), 'developer')
  })
  await check('all modes fit a 360px viewport including expanded details', async () => {
    await page.setViewportSize({ width: 360, height: 800 })
    for (const mode of ['daily', 'advanced', 'developer']) {
      await selectMode(mode)
      while (await page.locator('button[aria-expanded="false"]:visible').count()) {
        await page.locator('button[aria-expanded="false"]:visible').first().click()
      }
      // Finish finite transitions before measuring the final layout.
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)))
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth }))
      assert.ok(dimensions.width <= dimensions.viewport + 1, `${mode} overflows: ${JSON.stringify(dimensions)}`)
      await screenshot(page, `settings-${mode}-narrow.zh.png`)
    }
  })
  await check('reduced motion disables transitions and keyframe animations', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const styles = await page.locator('.dph-collapse, .dph-chevron, .dph-enter').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node); return { transition: style.transitionDuration, animation: style.animationName }
    }))
    assert.ok(styles.length > 0)
    assert.ok(styles.every(style => style.transition.split(',').every(value => parseFloat(value) === 0) && style.animation === 'none'))
  })
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
  await screenshot(page, 'settings-developer-dark.zh.png')
  await check('dark mode resolves readable theme colors', async () => {
    const colors = await panel.evaluate(node => ({ text: getComputedStyle(node).color, background: getComputedStyle(document.body).backgroundColor }))
    assert.notEqual(colors.text, colors.background)
    assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true)
  })
  await check('the startup counters say what they count', async () => {
    const metrics = page.locator('.dph-metric')
    assert.deepEqual(await metrics.locator('.dph-metric-label').allTextContents(), ['运行中', '激活失败', '其他状态'])
    assert.equal(await metrics.filter({ hasText: '激活失败' }).locator('strong').innerText(), '1')
  })

  await check('the loader list searches and groups', async () => {
    await selectMode('advanced')
    await page.waitForTimeout(600)

    const trigger = page.locator('.dph-trigger').filter({ hasText: /启动记录|加载条目/u }).first()
    assert.ok(await trigger.count() > 0, 'no loader-list trigger in advanced mode')
    // It is a toggle, and earlier checks may already have opened it.
    if (await trigger.getAttribute('aria-expanded') !== 'true') {
      await trigger.click()
      await page.waitForTimeout(400)
    }

    const box = page.locator('input[type="search"]').first()
    assert.equal(await box.isVisible(), true, 'opening the list must reveal the search box')

    const labels = await page.locator('.dph-group-label').allTextContents()
    assert.ok(labels.length >= 1, 'entries should be grouped by origin: ' + JSON.stringify(labels))

    const before = await page.locator('.dph-row').count()
    assert.ok(before >= 1, 'the fixture should list at least one entry')
    const first = (await page.locator('.dph-row strong').first().innerText()).split('@')[0].trim()
    await box.fill(first)
    await page.waitForTimeout(400)
    assert.ok(await page.locator('.dph-row').count() <= before, 'typing must not widen the list')

    await box.fill('zzz-nothing-matches')
    await page.waitForTimeout(400)
    assert.equal(await page.locator('text=没有匹配').count(), 1, 'an empty result must say so')
    await box.fill('')
    await page.waitForTimeout(300)

    // Return to daily so the checks after this one see the mode they expect.
    await selectMode('daily')
    await page.waitForTimeout(400)
  })

  await check('normal interactions issue no write requests', async () => {
    assert.equal(requests.filter(row => row.method !== 'GET').length, 0)
  })
  await check('repair submits the reviewed planToken only after confirmation and suppresses duplicate clicks', async () => {
    allowScriptedRepair = true
    await selectMode('daily')
    await page.getByRole('button', { name: '清理 1 项损坏文件', exact: true }).evaluate(node => { node.click(); node.click() })
    const confirm = page.getByRole('button', { name: '确认修复', exact: true })
    await confirm.waitFor()
    let writes = requests.filter(row => row.method === 'POST')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].body.dryRun, true)
    assert.equal(Object.hasOwn(writes[0].body, 'planToken'), false)
    await confirm.evaluate(node => { node.click(); node.click() })
    await page.getByText('已修复 1 项', { exact: true }).waitFor()
    writes = requests.filter(row => row.method === 'POST')
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[1].body, { dryRun: false, planToken: 'qa-plan-token' })
  })
  await check('startup trials require explicit risk confirmation and each plugin keeps separate state', async () => {
    allowScriptedRescue = true
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.reload()
    const first = page.locator('[data-plugin="example-first-plugin@1.0.0"]')
    const second = page.locator('[data-plugin="example-second-plugin@2.0.0"]')
    await first.getByRole('button', { name: '查看试运行说明', exact: true }).click()
    const confirmation = first.locator('[data-trial-confirmation]')
    assert.equal(await confirmation.isVisible(), true)
    assert.match(await confirmation.innerText(), /下载、安装并运行插件代码/)
    assert.match(await confirmation.innerText(), /Health 无法阻止它的恶意行为/)
    assert.equal(await confirmation.getByRole('heading').evaluate(node => node === document.activeElement), true)
    assert.equal(requests.filter(row => row.path.includes('/rescue/')).length, 0)
    await screenshot(page, 'settings-trial-confirmation.zh.png')
    await first.getByRole('button', { name: '取消试运行', exact: true }).click()
    assert.equal(requests.filter(row => row.path.includes('/rescue/')).length, 0)
    await first.getByRole('button', { name: '查看试运行说明', exact: true }).click()
    await first.getByRole('button', { name: '我信任此插件，开始试运行', exact: true }).evaluate(node => { node.click(); node.click() })
    await first.getByRole('button', { name: '允许下次尝试启动', exact: true }).waitFor()
    const rehearsals = requests.filter(row => row.path.includes('/rescue/'))
    assert.equal(rehearsals.length, 1)
    assert.deepEqual(rehearsals[0].body, { plugin: 'example-first-plugin', version: '1.0.0' })
    assert.equal(await second.getByRole('button', { name: '查看试运行说明', exact: true }).isVisible(), true)
    assert.equal(await second.getByRole('button', { name: '允许下次尝试启动', exact: true }).count(), 0)
  })
  await check('the update strip finds the real settings control and never presses another', async () => {
    // Markup from @deepseek-ai/dsh-client-ui-settings-general 0.2.1-rc.4: dialog at lib/client.js:280-293,
    // button at :451-462. Re-check against the package when the supported host range moves.
    const realButton = '<button aria-label="Settings" aria-haspopup="dialog" aria-expanded="false">gear</button>'
    const extract = (opening) => {
      const at = clientSource.indexOf(opening)
      // Fail loudly: the previous version substituted placeholders, so a scene expecting "cannot open"
      // passed against (() => false).
      if (at < 0) throw new Error('helper not found in client.js: ' + opening)
      if (opening.includes('SELECTORS = [')) {
        let depth = 0
        for (let i = at; i < clientSource.length; i += 1) {
          if (clientSource[i] === '[') depth += 1
          else if (clientSource[i] === ']') { depth -= 1; if (depth === 0) return clientSource.slice(at, i + 1) }
        }
        throw new Error('unbalanced array: ' + opening)
      }
      let depth = 0, seen = false
      for (let i = at; i < clientSource.length; i += 1) {
        if (clientSource[i] === '{') { depth += 1; seen = true }
        else if (clientSource[i] === '}') { depth -= 1; if (seen && depth === 0) return clientSource.slice(at, i + 1) }
      }
      throw new Error('unbalanced function: ' + opening)
    }
    const helpers = ['const SETTINGS_DIALOG_SELECTORS = [', 'const SETTINGS_SELECTORS = [',
      'const settingsVisible = () => {', 'const clickShellTrigger = () => {',
      'const openSettingsSurface = (done) => {'].map(extract).join('\n')

    const scenes = [
      { name: 'real markup, settings button present', body: '<nav><button data-strip>strip</button>' + realButton + '</nav>', expectOpen: true },
      { name: 'no settings button', body: '<nav><button data-strip>strip</button></nav>', expectOpen: false },
      { name: 'a gear without aria-haspopup must not be pressed', body: '<main><button id="danger" aria-label="Settings">Reset all settings</button></main><nav><button data-strip>strip</button></nav>', expectOpen: false },
      { name: 'an unrelated dialog does not count as settings', body: '<div role="dialog" aria-modal="true">Saved</div><nav><button data-strip>strip</button>' + realButton + '</nav>', expectOpen: true },
    ]

    for (const scene of scenes) {
      const probe = await browser.newPage()
      const pageErrors = []
      probe.on('pageerror', (e) => pageErrors.push(String(e)))
      await probe.setContent('<body>' + scene.body + '<script>' + [
        'window.log = []', 'window.result = null', helpers,
        "document.querySelectorAll('[data-strip]').forEach((s) => s.addEventListener('click', () => { window.log.push('strip'); openSettingsSurface((ok) => { window.result = ok }) }))",
        "document.querySelectorAll('button[aria-haspopup=\"dialog\"][aria-label=\"Settings\"]').forEach((b) => b.addEventListener('click', () => { window.log.push('trigger'); setTimeout(() => { const d = document.createElement('div'); d.setAttribute('role','dialog'); d.setAttribute('aria-modal','true'); d.setAttribute('data-shortcut-modal','settings'); document.body.append(d) }, 50) }))",
        "document.querySelectorAll('#danger').forEach((b) => b.addEventListener('click', () => window.log.push('DANGER')))",
      ].join('\n') + '</script></body>')
      await probe.click('[data-strip]')
      await probe.waitForTimeout(600)
      const log = await probe.evaluate(() => window.log)
      const result = await probe.evaluate(() => window.result)
      const opened = await probe.evaluate(() => !!document.querySelector('[data-shortcut-modal="settings"]'))
      assert.equal(log.includes('DANGER'), false, scene.name + ': pressed another control')
      assert.equal(log.filter((x) => x === 'strip').length, 1, scene.name + ': the strip clicked itself')
      assert.equal(opened, scene.expectOpen, scene.name + ': dialog state')
      assert.equal(result, opened, scene.name + ': reported ' + result + ' while the dialog was ' + opened)
      assert.deepEqual(pageErrors, [], scene.name + ': runtime errors')
      await probe.close()
    }
  })

  await check('React/browser report no runtime errors', async () => { assert.deepEqual(errors, []) })
  writeFileSync(join(out, 'browser-qa.json'), JSON.stringify({ passed: true, checks, errors, warnings,
    sourceSha256, browser: browser.version(), fixture: true, nativeDshDesktop: false, requests }, null, 2) + '\n')
  console.log(`Browser QA passed: ${checks.length} checks; screenshots in ${out}`)
} catch (error) {
  writeFileSync(join(out, 'browser-qa.json'), JSON.stringify({ passed: false, checks, errors, warnings, failure: error.stack,
    sourceSha256, fixture: true, nativeDshDesktop: false, requests }, null, 2) + '\n')
  throw error
} finally {
  if (browser) await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
