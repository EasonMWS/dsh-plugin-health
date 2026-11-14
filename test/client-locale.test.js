import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const clientSource = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')
const snapshot = {
  issues: [{ id: 'bundle-manifest-invalid', severity: 'error', autoFixable: true, detail: 'C:\\dsh\\broken\\package.json' }],
  summary: { error: 1, warn: 0 }, scanned: { plugins: { total: 3 } },
  repairKey: 'test-key', generatedAt: '2026-10-27T12:00:00Z', runtimeVersion: '0.2.1-rc.2', profile: 'desktop', home: 'C:\\dsh',
}

// Render the published browser entry without a DOM or network. Hooks retain state between
// renders so tests can exercise expansion, repair confirmation, and a host language change.
function client({ data = snapshot, failure, planned, result, fetchStatus, fetchRepair, timers } = {}) {
  const slots = new Map(), dictionaries = new Map(), instances = new Map(), requests = []
  const storage = new Map()
  let language = 'en', active, pendingEffects = [], exports
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const record = active, index = record.cursor++
      if (!(index in record.hooks)) record.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [record.hooks[index], (value) => { record.hooks[index] = typeof value === 'function' ? value(record.hooks[index]) : value }]
    },
    useRef(initial) {
      const index = active.cursor++
      if (!(index in active.hooks)) active.hooks[index] = { current: initial }
      return active.hooks[index]
    },
    useCallback(callback, deps) {
      const index = active.cursor++, previous = active.hooks[index]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) active.hooks[index] = { callback, deps }
      return active.hooks[index].callback
    },
    useEffect(callback, deps) {
      const index = active.cursor++, previous = active.hooks[index]
      if (!previous || deps.some((value, i) => value !== previous[i])) pendingEffects.push(callback)
      active.hooks[index] = deps
    },
  }
  const locale = {
    register: (namespace, dict) => { dictionaries.set(namespace, dict) },
    bind: (namespace) => (key, params = {}) => {
      const dict = dictionaries.get(namespace)
      return (dict?.[language]?.[key] ?? dict?.en?.[key] ?? key).replace(/\{(\w+)\}/gu, (match, name) => params[name] ?? match)
    },
  }
  const ctx = {
    locale, effect: (fn) => fn(), inject: (_names, fn) => fn(ctx), get: () => undefined,
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, component) => { slots.set(meta.id, { meta, component }); return () => slots.delete(meta.id) },
    },
  }
  runInNewContext(clientSource, {
    AbortController, setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout,
    URL, URLSearchParams,
    window: {
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => React) } },
    },
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url.includes('/status')) return fetchStatus ? fetchStatus(url) : { ok: !failure, status: 503, json: async () => data }
      assert.ok(url.endsWith('/repair'))
      if (fetchRepair) return fetchRepair(JSON.parse(options.body))
      return { ok: true, json: async () => JSON.parse(options.body).dryRun ? planned : result }
    },
  })
  exports.apply(ctx)
  function expand(node, path) {
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const id = `${path}/${node.type.name}`
      if (!instances.has(id)) instances.set(id, { hooks: [] })
      active = instances.get(id)
      active.cursor = 0
      return expand(node.type(node.props), id)
    }
    return { ...node, children: node.children.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`)) }
  }
  return {
    slots, dictionaries, requests, storage,
    setLocale: (next) => { language = next },
    render(id = 'plugin-health') {
      const { meta, component } = slots.get(id)
      // Mirrors the host slot contract: only a declared locale injects the translator.
      const props = { ...meta.inject?.(), ...(meta.locale ? { t: locale.bind(meta.locale) } : {}) }
      const tree = expand(React.createElement(component, props), id)
      const effects = pendingEffects
      pendingEffects = []
      effects.forEach((effect) => effect())
      return tree
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
function text(node) {
  if (node == null || typeof node === 'boolean' || node.type === 'style' || node.props?.hidden || node.props?.['aria-hidden'] === true) return ''
  return typeof node === 'object' ? node.children.map(text).join(' ') : String(node)
}
function find(node, predicate) {
  if (!node || typeof node !== 'object' || node.type === 'style' || node.props?.hidden || node.props?.['aria-hidden'] === true) return undefined
  return predicate(node) ? node : node.children.map((child) => find(child, predicate)).find(Boolean)
}
function button(tree, label) {
  const found = find(tree, (node) => node.type === 'button' && text(node).trim() === label)
  assert.ok(found, `missing button: ${label}`)
  return found
}

test('English settings body, findings, details and sidebar follow the host language', async () => {
  const app = client()
  assert.equal(app.slots.get('plugin-health').meta.label(), 'Plugin health')
  const loading = text(app.render())
  assert.match(loading, /Plugin health.*Scanning….*Checking…/u)
  assert.doesNotMatch(loading, /\p{Script=Han}/u)
  await settle()
  let tree = app.render()
  assert.match(text(tree), /Plugin files are damaged.*Affects usage.*Details/u)
  assert.doesNotMatch(text(tree), /\p{Script=Han}/u)
  find(tree, (node) => node.props.onClick && text(node).includes('Plugin files are damaged')).props.onClick()
  tree = app.render()
  assert.match(text(tree), /installation information cannot be read/u)
  assert.ok(!text(tree).includes(snapshot.issues[0].detail))
  button(tree, 'View diagnostic details').props.onClick()
  tree = app.render()
  assert.ok(text(tree).includes(snapshot.issues[0].detail))
  assert.match(text(tree), /Next step: Back up the damaged files/u)
  const alert = app.render('plugin-health-alert')
  assert.equal(alert.props.title, 'View plugin health results')
  assert.match(text(alert), /Plugin issues: 1.*View/u)

  app.setLocale('zh')
  assert.equal(app.slots.get('plugin-health').meta.label(), '插件健康')
  tree = app.render()
  assert.match(text(tree), /插件文件损坏.*会影响使用.*收起/u)
  assert.match(text(tree), /怎么做：先备份损坏文件/u)
  assert.match(text(app.render('plugin-health-alert')), /插件有 1 个问题.*查看/u)
  app.setLocale('en')
  assert.match(text(app.render()), /Plugin files are damaged.*Collapse/u)
})

test('English repair plan and results stay localized without changing the confirmation flow', async () => {
  const app = client({
    planned: { planned: [
      { id: 'bundle-manifest-invalid', description: '后端默认说明' },
      { id: 'future-repair', description: 'Host-provided repair description' },
    ], manual: 2, planToken: 'preview-token' },
    result: { actions: [{ kind: 'quarantine', from: 'C:\\dsh\\broken' }, { kind: 'rewrite', file: 'C:\\dsh\\cordis.patch.yml' }], quarantineDir: 'C:\\dsh\\quarantine' },
  })
  app.render()
  await settle()
  const planning = button(app.render(), 'Clean up 1 broken file(s)').props.onClick()
  assert.match(text(app.render()), /Preparing repair plan…/u)
  await planning
  let tree = app.render()
  assert.match(text(tree), /Planned actions.*Move the damaged plugin folder to a backup location/u)
  assert.match(text(tree), /Host-provided repair description.*Items requiring manual action: 2/u)
  assert.doesNotMatch(text(tree), /\p{Script=Han}/u)
  assert.equal(app.requests.filter(({ url }) => url.endsWith('/repair')).length, 1)
  assert.equal(JSON.parse(app.requests.at(-1).options.body).dryRun, true)
  button(tree, 'Cancel')
  const applying = button(tree, 'Confirm repair').props.onClick()
  assert.match(text(app.render()), /Applying…/u)
  await applying
  tree = app.render()
  assert.match(text(tree), /Items repaired: 2.*Moved to backup: C:\\dsh\\broken.*Rewritten: C:\\dsh\\cordis.patch.yml/u)
  assert.match(text(tree), /Backup location: C:\\dsh\\quarantine/u)
  assert.equal(JSON.parse(app.requests.filter(({ url }) => url.endsWith('/repair')).at(-1).options.body).dryRun, false)
  assert.equal(JSON.parse(app.requests.filter(({ url }) => url.endsWith('/repair')).at(-1).options.body).planToken, 'preview-token')
  // Hosts that omit a key from the status body still work with the same-origin cookie fallback.
  assert.equal(app.requests.find(({ url }) => url.endsWith('/repair')).options.headers['x-plugin-health-key'], undefined)
  assert.equal(app.requests.find(({ url }) => url.endsWith('/repair')).options.credentials, 'same-origin')
  button(tree, 'Done').props.onClick()
  button(app.render(), 'Clean up 1 broken file(s)')
})

test('healthy, failed and manual-only checks use English copy', async () => {
  const healthy = client({ data: { ...snapshot, issues: [{ id: 'registry-mirror', severity: 'info' }], summary: {} } })
  healthy.render()
  await settle()
  const healthyText = text(healthy.render())
  assert.match(healthyText, /No issues found in this scan.*Installation scan: 3 packages/u)
  assert.equal(healthyText.match(/Installation scan: 3 packages/gu).length, 1)
  button(healthy.render(), 'Copy configuration check command')
  assert.doesNotMatch(healthyText, /After the next DSH upgrade, if a plugin is rejected|What you can do now|Browse compatibility across the whole catalog|No warnings in this scan|No installation or configuration issues found/u)
  assert.match(healthyText, /Informational findings omitted: 1/u)
  assert.doesNotMatch(healthyText, /\p{Script=Han}/u)
  assert.equal(healthy.slots.has('plugin-health-alert'), false)
  healthy.setLocale('zh')
  const healthyZh = text(healthy.render())
  assert.match(healthyZh, /本次检查未发现问题.*安装扫描：3 个包/u)
  assert.doesNotMatch(healthyZh, /下次 DSH 升级后如果有插件被拒|现在可以先做这些|浏览全部插件的兼容情况|本次体检无警告|本次体检未发现安装或配置问题/u)

  const failed = client({ failure: true })
  failed.render()
  await settle()
  assert.match(text(failed.render()), /Check failed.*Select Rescan to try again/u)
  assert.doesNotMatch(text(failed.render()), /HTTP 503/u)
  button(failed.render(), 'View diagnostic details').props.onClick()
  assert.match(text(failed.render()), /HTTP 503/u)

  const manual = client({ planned: { planned: [], manual: 1 } })
  manual.render()
  await settle()
  await button(manual.render(), 'Clean up 1 broken file(s)').props.onClick()
  assert.match(text(manual.render()), /These issues need manual action/u)
})

test('new host findings preserve their original title, details and suggested fix', async () => {
  const issue = { id: 'future-finding', severity: 'warn', title: '<plugin-name> needs attention', detail: 'C:\\用户\\plugin', fix: 'Keep the original host advice' }
  const app = client({ data: { ...snapshot, issues: [issue], summary: { warn: 1 } } })
  app.render()
  await settle()
  let tree = app.render()
  find(tree, (node) => node.props.onClick && text(node).includes(issue.title)).props.onClick()
  tree = app.render()
  assert.ok(text(tree).includes(issue.title))
  assert.ok(!text(tree).includes(issue.detail))
  button(tree, 'View diagnostic details').props.onClick()
  tree = app.render()
  assert.ok(text(tree).includes(issue.detail))
  assert.match(text(tree), /Next step: Keep the original host advice/u)
  assert.doesNotMatch(text(tree), /finding\.future-finding/u)
})

test('Chinese and English dictionaries cover the same keys and interpolation parameters', () => {
  const app = client()
  const { zh, en } = app.dictionaries.get('plugin-health')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  assert.ok(Object.keys(en).some((key) => key.startsWith('finding.')), 'finding copy must be registered')
  for (const key of Object.keys(en)) {
    assert.doesNotMatch(en[key], /\p{Script=Han}/u, key)
    assert.deepEqual(en[key].match(/\{\w+\}/gu), zh[key].match(/\{\w+\}/gu), key)
  }
})

test('the settings header uses buttons and keeps setup and runtime counts distinct in both languages', async () => {
  const app = client({ data: { ...snapshot, liveReview: {
    entries: [
      { id: 'root/start', name: 'example-plugin', state: 'failed', diagnostic: { kind: 'duplicate-tool', tool: 'search' } },
      { id: 'root/active', name: 'active-plugin', state: 'active' },
      { id: 'root/tool', name: 'active-plugin', state: 'active' },
      { id: 'root/disabled', name: 'disabled-plugin', state: 'disabled' },
      { id: 'root/waiting', name: 'waiting-plugin', state: 'pending' },
    ],
    changes: [], sampledAt: '2026-11-05T12:00:00Z',
  } } })
  app.render()
  await settle()
  const removed = {
    zh: [
      /查看当前配置的插件、加载状态和安装问题|查看哪些插件有问题，以及接下来可以怎么处理|追踪插件启动变化，排查设置冲突，了解升级影响/u,
      /先确认能否正常使用|看懂问题，按提示处理|追踪加载变化，检查配置|看看问题出现在哪里|保留现场证据，为可信插件/u,
      /查看使用问题和修复入口|适合日常使用，只展开|查看加载变化、配置覆盖和升级预检|适合经常安装或调整插件的用户|在进阶诊断的基础上导出/u,
      /切换模式只调整信息展示|三种模式检查的内容相同/u,
      /问题与修复|验证与导出/u,
      /运行中 \d+ 项，激活失败 \d+ 项|已启动 \d+ 项，未能启动 \d+ 项|已启动 \d+ 项，启动失败 \d+ 项/u,
      /已检查 \d+ 个已安装插件|共检查 \d+ 个插件/u,
      /每 30 秒|状态更新时间/u,
    ],
    en: [
      /Review installed packages, loader state|See which plugins have problems|Follow plugin startup changes, investigate setting conflicts/u,
      /Check whether things are working|Understand the problem and follow|Follow loader changes and inspect|Find where a problem starts|Keep evidence and reproduce startup issues/u,
      /See issues that affect use|For everyday use. Open more information|See runtime changes, configuration overrides|For people who regularly install|Export runtime evidence and use the CLI/u,
      /Changing the view adjusts the display|All views run the same checks/u,
      /Issues & recovery|Verify & export/u,
      /Active: \d+ · Failed to activate: \d+|Started: \d+ · Could not start: \d+|Started: \d+ · Startup failed: \d+/u,
      /Installed plugins checked: \d+|Plugins checked: \d+/u,
      /every 30 seconds|Status updated at/u,
    ],
  }
  for (const [locale, labels, group, counts, limit, rescan, cadence, diagnostic] of [
    ['zh', ['日常检查', '进阶诊断', '开发验证'], '显示模式', /安装扫描：3 个包.*启动状态（加载条目）.*运行中 2.*激活失败 1.*其他状态 2/u, /无法查杀病毒或阻止恶意程序扩散/u, '重新扫描', /扫描为只读.*每 30 秒.*状态更新时间/u, /功能名称「search」被重复使用/u],
    ['en', ['Daily', 'Advanced', 'Developer'], 'View', /Installation scan: 3 packages.*Startup status \(loader entries\).*Running 2.*Activation failed 1.*Other states 2/u, /cannot remove malware or stop it spreading/u, 'Rescan', /Scanning is read-only.*every 30 seconds.*Status updated at/u, /The feature name search is used more than once/u],
  ]) {
    app.setLocale(locale)
    for (const [index, mode] of ['daily', 'advanced', 'developer'].entries()) {
      const before = app.render()
      const modes = find(before, node => node.props.role === 'group' && node.props['aria-label'] === group)
      assert.ok(modes, 'mode controls have an accessible group')
      assert.equal(button(modes, labels[index]).props['aria-label'], labels[index])
      button(modes, labels[index]).props.onClick()
      const tree = app.render()
      assert.equal(tree.props['data-view'], mode)
      assert.equal(app.storage.get('dsh-plugin-health:view'), mode)
      for (const label of labels) assert.equal(button(tree, label).props['aria-pressed'], label === labels[index])
      assert.equal(find(tree, node => node.type === 'select'), undefined)
      const rendered = text(tree)
      for (const copy of removed[locale]) assert.doesNotMatch(rendered, copy)
      assert.match(rendered, counts)
      assert.match(text(find(tree, node => node.type === 'footer')), limit)
      assert.match(button(tree, rescan).props['aria-description'], cadence)
      assert.match(rendered, /example-plugin/u)
      if (mode === 'daily') assert.match(rendered, diagnostic)
      if (locale === 'en') assert.doesNotMatch(rendered, /\p{Script=Han}/u)
      else assert.doesNotMatch(rendered, /Installation scan|Startup status|Activation failed|Scanning is read-only|View diagnostic details/u)
    }
  }
  assert.equal(app.requests.filter(request => request.options?.method === 'POST').length, 0)
})

test('upgrade previews count assessed declarations, including exemptions, and never claim packages work', async () => {
  const target = '0.2.2-rc.1'
  const states = ['compatible', 'undeclared', 'unknown', 'not-checked', 'exempted', 'incompatible']
  const makeResponse = (targetVersion, lastState) => ({
    ...snapshot,
    review: {
      profile: snapshot.profile, currentVersion: snapshot.runtimeVersion, targetVersion,
      packages: states.map((state, index) => ({
        name: 'fixture-' + index, declaration: { state: index === 5 ? lastState : state },
      })),
      patches: [], limits: [], findings: [],
    },
  })
  let lastState = 'incompatible'
  const app = client({ fetchStatus: async url => ({
    ok: true,
    json: async () => makeResponse(new URL(url, 'http://127.0.0.1').searchParams.get('target'), lastState),
  }) })
  app.render()
  await settle()
  for (const [locale, advanced, matches, clean, obsolete] of [
    ['en', 'Advanced', /Packages with assessed declarations: 3 · Package mismatches without exemptions: 1/u, /Packages with assessed declarations: 3 · Package mismatches without exemptions: 0/u, /all \d+ installed plugins still work|\d+ plugins would be affected/u],
    ['zh', '进阶诊断', /已判定声明：3 个包 · 声明不匹配且未放行：1 个包/u, /已判定声明：3 个包 · 声明不匹配且未放行：0 个包/u, /当前 \d+ 个插件都能用|\d+ 个插件会受影响/u],
  ]) {
    app.setLocale(locale)
    button(app.render(), advanced).props.onClick()
    for (const isInline of [true, false]) {
      const scope = tree => find(tree, node => isInline
        ? Object.hasOwn(node.props, 'data-dph-upgrade-preview')
        : node.props.key === 'advanced-review')
      const control = type => find(scope(app.render()), node => node.type === type)
      const preview = async state => {
        lastState = state
        control('input').props.onChange({ target: { value: target } })
        await control('form').props.onSubmit({ preventDefault() {} })
        return text(scope(app.render()))
      }
      const affected = await preview('incompatible')
      assert.match(affected, matches)
      assert.doesNotMatch(affected, obsolete)
      const unaffected = await preview('compatible')
      assert.match(unaffected, clean)
      assert.doesNotMatch(unaffected, obsolete)
    }
  }
})

test('finding disclosure keeps its body inert when closed and controls the same region', async () => {
  const app = client()
  app.render(); await settle()
  const trigger = tree => find(tree, node => node.type === 'button' && text(node).includes('Plugin files are damaged'))
  let tree = app.render()
  const control = trigger(tree)
  assert.equal(control.props['aria-expanded'], false)
  const id = control.props['aria-controls']
  assert.ok(id)
  assert.doesNotMatch(text(tree), /installation information cannot be read/u)
  control.props.onClick()
  tree = app.render()
  assert.equal(trigger(tree).props['aria-expanded'], true)
  const body = find(tree, node => node.props.id === id)
  assert.equal(body.props.inert, undefined)
  assert.match(text(body), /installation information cannot be read/u)
  trigger(tree).props.onClick()
  assert.equal(trigger(app.render()).props['aria-controls'], id)
  assert.doesNotMatch(text(app.render()), /installation information cannot be read/u)
})

test('a late status response cannot replace a newer manual scan', async () => {
  const pending = []
  const app = client({ fetchStatus: url => new Promise(resolve => pending.push({ url, resolve })) })
  app.render()
  assert.equal(pending.length, 2) // Sidebar and panel.
  const rescan = find(app.render(), node => node.type === 'button' && text(node) === 'Scanning…').props.onClick()
  const fresh = { ...snapshot, issues: [], summary: {}, scanned: { plugins: { total: 8 } } }
  pending[2].resolve({ ok: true, json: async () => fresh })
  await rescan
  assert.match(text(app.render()), /Installation scan: 8 packages/u)
  for (const request of pending.slice(0, 2)) request.resolve({ ok: true, json: async () => snapshot })
  await settle()
  assert.match(text(app.render()), /Installation scan: 8 packages/u)
  assert.doesNotMatch(text(app.render()), /Plugin files are damaged/u)
})

test('a failed refresh preserves last findings, marks them stale and removes the clean verdict', async () => {
  let fail = false
  const app = client({ fetchStatus: async () => ({ ok: !fail, status: 503, json: async () => snapshot }) })
  app.render(); await settle()
  fail = true
  await button(app.render(), 'Rescan').props.onClick()
  const tree = app.render()
  assert.match(text(tree), /Refresh failed.*last results remain/u)
  assert.match(text(tree), /Plugin files are damaged/u)
  assert.doesNotMatch(text(tree), /No issues found in this scan|Clean up 1 broken/u)
})

test('a changed repair plan reports failure and retries through a new preview only', async () => {
  const writes = []
  const app = client({ fetchRepair: async body => {
    writes.push(body)
    return body.dryRun
      ? { ok: true, json: async () => ({ planned: [{ id: 'bundle-manifest-invalid' }], manual: 0, planToken: 'reviewed-plan' }) }
      : { ok: false, status: 409, json: async () => ({ error: 'repair plan changed; preview again' }) }
  } })
  app.render(); await settle()
  await button(app.render(), 'Clean up 1 broken file(s)').props.onClick()
  await button(app.render(), 'Confirm repair').props.onClick()
  const failed = app.render()
  assert.match(text(failed), /Repair did not complete/u)
  button(failed, 'View diagnostic details').props.onClick()
  assert.match(text(app.render()), /repair plan changed/u)
  await button(failed, 'Build a new plan').props.onClick()
  assert.deepEqual(writes.map(body => body.dryRun), [true, false, true])
  assert.equal(writes[1].planToken, 'reviewed-plan')
  button(app.render(), 'Confirm repair')
})

test('a stalled initial read times out and re-enables rescan', async () => {
  const pending = new Map()
  let serial = 0, hanging = true
  const app = client({
    timers: { setTimeout: fn => { const id = ++serial; pending.set(id, fn); return id }, clearTimeout: id => pending.delete(id) },
    fetchStatus: () => hanging ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => snapshot }),
  })
  app.render()
  assert.equal(button(app.render(), 'Scanning…').props.disabled, true)
  for (const callback of [...pending.values()]) callback()
  await settle()
  assert.match(text(app.render()), /read timed out/u)
  assert.equal(button(app.render(), 'Rescan').props.disabled, false)
  hanging = false
  await button(app.render(), 'Rescan').props.onClick()
  assert.match(text(app.render()), /Plugin files are damaged/u)
  assert.equal(pending.size, 0)
})
