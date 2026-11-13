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
    URL,
    window: { __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => React) } } },
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
    slots, dictionaries, requests,
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
  assert.match(healthyText, /No warnings in this scan.*Plugins checked: 3, DSH 0.2.1-rc.2.*No installation or configuration issues found/u)
  assert.match(healthyText, /Informational findings omitted: 1/u)
  assert.doesNotMatch(healthyText, /\p{Script=Han}/u)
  assert.equal(healthy.slots.has('plugin-health-alert'), false)

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

test('audience wording changes without hiding failures or implying malware protection', async () => {
  const app = client({ data: { ...snapshot, liveReview: {
    entries: [{ id: 'root/start', name: 'example-plugin', state: 'failed', diagnostic: { kind: 'duplicate-tool', tool: 'search' } }],
    changes: [], sampledAt: '2026-11-05T12:00:00Z',
  } } })
  app.setLocale('zh'); app.render(); await settle()
  let tree = app.render()
  assert.match(text(tree), /插件启动情况.*未能启动 1 项.*功能名称「search」被重复使用/u)
  // The counters are visible in every mode now, by design. What daily mode still must not show is
  // the technical vocabulary: profile names, package paths, version-exemption terms.
  assert.match(text(tree), /\u8fd0\u884c\u4e2d/u, 'the counters are readable in daily mode')
  assert.doesNotMatch(text(tree), /\u5bbf\u4e3b|Profile|package\.json|\u7248\u672c\u8c41\u514d/u)
  for (const mode of ['daily', 'advanced', 'developer']) {
    find(app.render(), node => node.type === 'select').props.onChange({ target: { value: mode } })
    tree = app.render()
    assert.match(text(tree), /无法查杀病毒或阻止恶意程序扩散/u)
    assert.match(text(tree), /example-plugin/u)
  }
  assert.match(text(tree), /宿主加载状态.*激活失败 1 项/u)
  assert.equal(app.requests.filter(request => request.options?.method === 'POST').length, 0)
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
  assert.match(text(app.render()), /Plugins checked: 8/u)
  for (const request of pending.slice(0, 2)) request.resolve({ ok: true, json: async () => snapshot })
  await settle()
  assert.match(text(app.render()), /Plugins checked: 8/u)
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
  assert.doesNotMatch(text(tree), /No warnings in this scan|Clean up 1 broken/u)
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
