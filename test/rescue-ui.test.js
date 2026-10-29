import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// The rescue panel is the part of this plugin a user actually operates, and until now it was
// covered only at the dictionary level: nothing asserted that a click moved the UI into the
// expected state. These tests drive the published browser entry with a hook stub, so they
// exercise the real component code without a DOM.

const clientSource = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')

const PLUGIN = { name: 'legacy-plugin', version: '1.0.0', requirements: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' }, id: 'legacy' }

function snapshot({ rescuable = [PLUGIN], rescues = [] } = {}) {
  return {
    issues: rescuable.length === 0 ? [] : [{
      id: 'plugin-incompatible', severity: 'warn',
      title: `Installed plugin is incompatible: ${rescuable[0].name}@${rescuable[0].version}`,
      detail: 'Unmet requirements', fix: 'Update or exempt', autoFixable: false,
    }],
    summary: { error: 0, warn: rescuable.length }, scanned: { plugins: { total: 3 } },
    repairKey: 'test-key', generatedAt: '2026-10-29T12:00:00Z', runtimeVersion: '0.2.1-rc.4',
    profile: 'desktop', home: 'C:\\dsh',
    rescuable, rescues, incompatible: rescuable.length,
  }
}

/**
 * Render the browser bundle and route rescue requests to scripted responses.
 * `handler(action, body)` returns the JSON body the fake server sends back.
 */
function client({ data = snapshot(), handler } = {}) {
  const slots = new Map(), dictionaries = new Map(), instances = new Map(), requests = []
  let language = 'en', active, pendingEffects = [], exports
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const record = active, index = record.cursor++
      if (!(index in record.hooks)) record.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [record.hooks[index], (value) => { record.hooks[index] = typeof value === 'function' ? value(record.hooks[index]) : value }]
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
    window: { __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => React) } } },
    navigator: { clipboard: { writeText: async (value) => { requests.push({ url: 'clipboard', body: value }) } } },
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (url, options = {}) => {
      const body = options.body === undefined ? undefined : JSON.parse(options.body)
      requests.push({ url, body })
      if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => data }
      if (url.endsWith('/repair')) return { ok: true, json: async () => ({ planned: [], manual: 0, actions: [] }) }
      const action = url.split('/').at(-1)
      const payload = handler === undefined ? {} : handler(action, body)
      if (payload === undefined) return { ok: false, status: 400, json: async () => ({ error: `no script for ${action}` }) }
      return { ok: true, json: async () => payload }
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
    slots, requests,
    setLocale: (next) => { language = next },
    render(id = 'plugin-health') {
      const { meta, component } = slots.get(id)
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
const flatten = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  return node.children.map(flatten).join(' ')
}
const findAll = (node, predicate, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children) findAll(child, predicate, out)
  return out
}
const buttons = (tree) => findAll(tree, node => node.type === 'button')
const click = (tree, label) => {
  const found = buttons(tree).find(node => flatten(node).trim() === label)
  assert.ok(found, `missing button: ${label}\n  have: ${buttons(tree).map(node => flatten(node).trim()).join(' | ')}`)
  return found.props.onClick()
}

test('the rescue panel renders the plugin and one check button', async () => {
  const app = client()
  const tree = app.render()
  await settle()
  const view = app.render()
  assert.match(flatten(view), /legacy-plugin/u)
  assert.match(flatten(view), /Fix compatibility/u, 'the section heading is the compatibility one')
  assert.deepEqual(buttons(view).map(node => flatten(node).trim()), ['Rescan', 'Check whether it can be saved'])
})

test('a rehearsal that boots offers the exemption, not a dead end', async () => {
  const app = client({
    handler: action => action === 'rehearse'
      ? { verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns', canApply: true, hostVersion: '0.2.1-rc.4' }
      : undefined,
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved')
  await settle()
  const view = app.render()
  assert.match(flatten(view), /only the declaration is out of date/u)
  assert.deepEqual(buttons(view).map(node => flatten(node).trim()), ['Rescan', 'Exempt temporarily'])
})

test('exempting asks for confirmation before writing anything', async () => {
  const written = []
  const app = client({
    handler: (action, body) => {
      if (action === 'rehearse') return { verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns', canApply: true, hostVersion: '0.2.1-rc.4' }
      if (action === 'apply') { written.push(body); return { applied: true, verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns' } }
      return undefined
    },
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  // The first click only reveals the consequences; nothing may be written yet.
  await click(app.render(), 'Exempt temporarily'); await settle()
  assert.equal(written.length, 0, 'no write may happen on the click that reveals the trade-off')
  const confirmView = app.render()
  assert.match(flatten(confirmView), /Confirm before exempting/u)
  assert.match(flatten(confirmView), /not official support/u, 'the limit is stated in the confirmation itself')
  await click(confirmView, 'Exempt it'); await settle()
  assert.equal(written.length, 1)
  assert.deepEqual(written[0], { plugin: 'legacy-plugin', version: '1.0.0' })
})

test('cancelling the confirmation writes nothing and returns to the verdict', async () => {
  const app = client({
    handler: action => action === 'rehearse'
      ? { verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns', canApply: true, hostVersion: '0.2.1-rc.4' }
      : undefined,
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  await click(app.render(), 'Exempt temporarily'); await settle()
  await click(app.render(), 'Cancel'); await settle()
  const view = app.render()
  assert.doesNotMatch(flatten(view), /Confirm before exempting/u)
  assert.deepEqual(buttons(view).map(node => flatten(node).trim()), ['Rescan', 'Exempt temporarily'])
  assert.equal(app.requests.filter(request => request.url.endsWith('/apply')).length, 0)
})

test('a plugin that cannot boot offers exactly two decisions and no exemption', async () => {
  const app = client({
    handler: action => action === 'rehearse'
      ? { verdict: 'broken', level: 'error', messageKey: 'rescueVerdictBrokenWhy', canApply: false }
      : undefined,
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  const view = app.render()
  // An exemption for a plugin that cannot boot would hide a real breakage behind a gate that
  // no longer warns, so the button must not exist at all.
  assert.doesNotMatch(flatten(view), /Exempt temporarily/u)
  assert.match(flatten(view), /Turn it off, keep using DSH/u)
  assert.match(flatten(view), /Let AI try to fix it/u)
  const labels = buttons(view).map(node => flatten(node).trim())
  assert.ok(labels.includes('Turn off'))
  assert.ok(labels.includes('Generate prompt'))
})

test('turning a plugin off sends its patch entry id', async () => {
  const sent = []
  const app = client({
    handler: (action, body) => {
      if (action === 'rehearse') return { verdict: 'broken', level: 'error', messageKey: 'rescueVerdictBrokenWhy', canApply: false }
      if (action === 'disable') { sent.push(body); return { disabled: true, entry: { name: 'legacy-plugin' } } }
      return undefined
    },
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  await click(app.render(), 'Turn off'); await settle()
  assert.deepEqual(sent, [{ plugin: 'legacy-plugin', entryId: 'legacy' }])
  assert.match(flatten(app.render()), /It will not load after a restart/u)
})

test('generating the AI brief shows the prompt and copies only when asked', async () => {
  const app = client({
    handler: (action) => {
      if (action === 'rehearse') return { verdict: 'broken', level: 'error', messageKey: 'rescueVerdictBrokenWhy', canApply: false }
      if (action === 'handoff') return { directory: 'C:\\dsh\\handoff', prompt: 'THE PROMPT TEXT', files: [] }
      return undefined
    },
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  await click(app.render(), 'Generate prompt'); await settle()
  const view = app.render()
  assert.match(flatten(view), /AI context is ready \(nothing sent\)/u)
  assert.match(flatten(view), /C:\\dsh\\handoff/u)
  // Copying is a separate, explicit click — the brief existing is not consent to touch the clipboard.
  assert.equal(app.requests.filter(request => request.url === 'clipboard').length, 0)
  await click(view, 'Copy prompt'); await settle()
  const copied = app.requests.filter(request => request.url === 'clipboard')
  assert.equal(copied.length, 1)
  assert.equal(copied[0].body, 'THE PROMPT TEXT')
})

test('checking upstream links existing reports and offers no drafting when one exists', async () => {
  const app = client({
    handler: (action) => {
      if (action === 'rehearse') return { verdict: 'broken', level: 'error', messageKey: 'rescueVerdictBrokenWhy', canApply: false }
      if (action === 'report') {
        return {
          slug: 'o/r', checked: true, existing: [{ number: 7, title: 'already reported', state: 'open', url: 'https://github.com/o/r/issues/7' }],
          newIssueUrl: 'https://github.com/o/r/issues/new', title: 't', body: 'b',
        }
      }
      return undefined
    },
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  await click(app.render(), 'See whether upstream already knows'); await settle()
  const view = app.render()
  assert.match(flatten(view), /already reported/u)
  assert.match(flatten(view), /#7/u)
  assert.doesNotMatch(flatten(view), /Open the new-issue page/u, 'a duplicate must not be encouraged')
})

test('recorded exemptions list an undo button that revokes that key', async () => {
  const revoked = []
  const app = client({
    data: snapshot({
      rescuable: [],
      rescues: [{ key: 'legacy-plugin@1.0.0', name: 'legacy-plugin', version: '1.0.0', runtimeVersion: '0.2.1-rc.4', active: true, stale: true, installedVersion: '1.1.0' }],
    }),
    handler: (action, body) => {
      if (action === 'undo') { revoked.push(body); return { undone: [{ key: body.key }], remaining: 0 } }
      return undefined
    },
  })
  app.render(); await settle()
  const view = app.render()
  assert.match(flatten(view), /Temporary exemptions/u)
  assert.match(flatten(view), /Upstream now has 1\.1\.0/u, 'a stale rescue tells the user they can upgrade')
  await click(view, 'Revoke'); await settle()
  assert.deepEqual(revoked, [{ key: 'legacy-plugin@1.0.0' }])
})

test('a failing request surfaces the message instead of silently doing nothing', async () => {
  const app = client({
    handler: (action) => {
      if (action === 'rehearse') return { verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns', canApply: true }
      if (action === 'apply') return undefined // the fake server answers 400
      return undefined
    },
  })
  app.render(); await settle()
  await click(app.render(), 'Check whether it can be saved'); await settle()
  await click(app.render(), 'Exempt temporarily'); await settle()
  await click(app.render(), 'Exempt it'); await settle()
  assert.match(flatten(app.render()), /no script for apply/u)
})

test('the rescue flow works in Chinese too', async () => {
  const app = client({
    handler: action => action === 'rehearse'
      ? { verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns', canApply: true, hostVersion: '0.2.1-rc.4' }
      : undefined,
  })
  app.setLocale('zh')
  app.render(); await settle()
  const first = app.render()
  assert.match(flatten(first), /修复兼容问题/u)
  await click(first, '检查能不能救'); await settle()
  assert.match(flatten(app.render()), /代码没问题，只是声明过时了/u)
})
