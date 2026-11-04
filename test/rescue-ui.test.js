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
function client({ data = snapshot(), handler, statusSequence, rejectFirstWrite = false } = {}) {
  const slots = new Map(), dictionaries = new Map(), instances = new Map(), requests = []
  /** Keyboard events the client dispatched, so a test can assert the settings shortcut fired. */
  const keyEvents = []
  /** Poll callbacks registered via setInterval, so a test can trigger a refresh on demand. */
  const intervals = []
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
    navigator: {
      clipboard: { writeText: async (value) => { requests.push({ url: 'clipboard', body: value }) } },
      platform: 'Win32',
      userAgent: 'Electron/44.7.0',
    },
    // Minimal DOM: enough for the sidebar alert to dispatch its shortcut and report failure.
    document: {
      activeElement: undefined,
      body: { dispatchEvent: () => true },
      title: '',
      querySelectorAll: () => [],
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init) {
        Object.assign(this, { type, ...init })
        keyEvents.push({
          type, key: init.key, code: init.code,
          ctrlKey: init.ctrlKey, metaKey: init.metaKey, altKey: init.altKey,
        })
      }
    },
    // Capture interval callbacks so a test can provoke a poll without waiting 60s.
    setInterval: (callback) => { intervals.push(callback); return 0 },
    clearInterval: () => {},
    fetch: async (url, options = {}) => {
      const body = options.body === undefined ? undefined : JSON.parse(options.body)
      requests.push({ url, body })
      // Simulate the cookie holding a key from the previous host launch: the first write is refused,
      // and reading the status route is what re-issues a usable key.
      if (rejectFirstWrite && options.method === 'POST' && !url.endsWith('/status')) {
        rejectFirstWrite = false
        return { ok: false, status: 401, json: async () => ({ error: 'missing or invalid control key' }) }
      }
      if (url.endsWith('/status')) {
        // `statusSequence` models the snapshot changing between polls; the last entry sticks.
        const payload = statusSequence !== undefined && statusSequence.length > 0
          ? (statusSequence.length > 1 ? statusSequence.shift() : statusSequence[0])
          : data
        return { ok: true, status: 200, json: async () => payload }
      }
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
    slots, requests, keyEvents,
    /** Run every registered poll callback once, simulating the 60s timer. */
    triggerRefresh() { for (const callback of intervals) callback() },
    /**
     * The sidebar alert registration. The slot's `inject()` supplies the props the component
     * receives, so `open` is the callback a click would run.
     */
    findAlert() {
      const entry = slots.get('plugin-health-alert')
      if (entry === undefined) return undefined
      return { props: entry.meta.inject?.() ?? {} }
    },
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
const links = (tree) => findAll(tree, node => node.type === 'a')
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
  assert.deepEqual(
    buttons(view).map(node => flatten(node).trim()),
    ['Rescan', 'Check for updates', 'Check whether it can be saved'],
  )
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
  assert.deepEqual(buttons(view).map(node => flatten(node).trim()), ['Rescan', 'Check for updates', 'Exempt temporarily'])
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
  assert.deepEqual(buttons(view).map(node => flatten(node).trim()), ['Rescan', 'Check for updates', 'Exempt temporarily'])
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

// --- the sidebar alert must actually open something -----------------------------------

test('the sidebar alert opens settings through the shell command, not selectPanel', async () => {
  // A user reported the 查看 button doing nothing. Root cause: the alert called
  // layout.selectPanel('settings'), but 'settings' is not a `main` panel key - it is a modal owned
  // by the shell - so selectPanel threw and an empty catch hid it. This test pins the working path.
  const app = client({
    data: { ...snapshot(), issues: [{ id: 'x', severity: 'warn', title: 'w', detail: 'd', fix: 'f' }] },
  })
  // The alert is registered from a fetch callback, so let the promise chain settle first.
  app.render()
  await settle()
  await settle()

  assert.equal(app.keyEvents.length, 0, 'nothing is dispatched until the user clicks')

  const alert = app.findAlert()
  assert.ok(alert, 'the sidebar alert should be registered when there are warnings')
  assert.equal(typeof alert.props.open, 'function', 'the alert must expose an open callback')
  alert.props.open()

  assert.ok(app.keyEvents.length >= 1, 'clicking must dispatch the settings shortcut')
  assert.equal(app.keyEvents[0].key, ',')
  assert.equal(app.keyEvents[0].code, 'Comma')
  assert.equal(String(app.keyEvents[0].ctrlKey || app.keyEvents[0].metaKey), 'true',
    'the shortcut needs a primary modifier or the host will not treat it as the command')
})

// --- the sidebar alert must not outlive the problem it reports -------------------------

test('the alert is removed once a rescan comes back clean', async () => {
  // A user saw "1 issue" after the panel itself showed nothing. The count was captured at
  // registration and the refresh returned early whenever the alert already existed, so a later
  // clean scan left a stale chip on screen.
  const app = client({
    data: { ...snapshot(), issues: [{ id: 'x', severity: 'warn', title: 'w', detail: 'd', fix: 'f' }] },
    // The second /status call returns a clean snapshot.
    statusSequence: [
      { ...snapshot(), issues: [{ id: 'x', severity: 'warn', title: 'w', detail: 'd', fix: 'f' }] },
      { ...snapshot(), issues: [] },
    ],
  })
  app.render()
  // The first snapshot arrives through a promise chain; give it a couple of turns.
  for (let i = 0; i < 4; i += 1) await settle()
  assert.ok(app.findAlert(), 'the alert appears while a warning exists')

  // Simulate the 60s poll, whose /status now returns the clean snapshot.
  app.triggerRefresh()
  for (let i = 0; i < 4; i += 1) await settle()
  assert.equal(app.findAlert(), undefined, 'a clean scan must remove the stale alert')
})

test('the header offers the compatibility page as a real link, opened in a new tab', async () => {
  const app = client()
  app.render()
  await settle()
  const view = app.render()
  const anchor = links(view).find((node) => /Browse all plugin health/u.test(flatten(node)))
  assert.ok(anchor, 'the panel must offer a way to the published table')
  assert.match(anchor.props.href, /dsh-plugin-health\/compat\/$/u)
  assert.equal(anchor.props.target, '_blank', 'it belongs in the system browser, not in the settings pane')
  assert.match(anchor.props.rel, /noopener/u)
})

test('asking for an update posts to the update route and reports up to date', async () => {
  const app = client({
    handler: (action) => (action === 'update'
      ? { currentVersion: '2.0.0', latestVersion: '2.0.0', updateAvailable: false, status: 'ok', checkedAt: null, error: null }
      : undefined),
  })
  app.render()
  await settle()
  const view = app.render()
  await click(view, 'Check for updates')
  await settle()
  const after = app.render()
  assert.ok(
    app.requests.some((request) => String(request.url).endsWith('/update')),
    'the click must reach the host',
  )
  assert.match(flatten(after), /latest version, 2\.0\.0/u)
})

test('an available update names the version and the exact command', async () => {
  const app = client({
    handler: (action) => (action === 'update'
      ? {
        currentVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'ok',
        checkedAt: null, error: null,
        upgradeHint: 'dsh plugin --profile desktop add dsh-plugin-health@2.1.0',
      }
      : undefined),
  })
  app.render()
  await settle()
  const view = app.render()
  await click(view, 'Check for updates')
  await settle()
  const text = flatten(app.render())
  assert.match(text, /Version 2\.1\.0 is available \(you have 2\.0\.0\)/u)
  // The command has to carry the version: "upgrade to latest" is how people end up on a build that
  // is not the one the panel just told them about.
  assert.match(text, /dsh-plugin-health@2\.1\.0/u)
})

test('a failed update check says it failed, not that everything is current', async () => {
  const app = client({ handler: () => undefined })
  app.render()
  await settle()
  const view = app.render()
  await click(view, 'Check for updates')
  await settle()
  const text = flatten(app.render())
  assert.match(text, /Could not reach the registry/u)
  assert.doesNotMatch(text, /latest version/u, 'a failed check must not read as an up-to-date one')
})

test('the update state that arrived with the status snapshot is shown without clicking anything', async () => {
  // The boot-time check already ran before the user opened this panel; the banner has to use it.
  const app = client({
    data: {
      ...snapshot(),
      update: {
        currentVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'ok',
        checkedAt: '2026-11-03T15:00:00Z', error: null,
        upgradeHint: 'dsh plugin --profile desktop add dsh-plugin-health@2.1.0',
      },
    },
  })
  app.render()
  await settle()
  const text = flatten(app.render())
  assert.match(text, /Version 2\.1\.0 is available/u)
})

test('the new controls are translated', async () => {
  const app = client()
  app.setLocale('zh')
  app.render()
  await settle()
  const text = flatten(app.render())
  assert.match(text, /检查更新/u)
  assert.match(text, /浏览全部插件健康状况/u)
})

test('a write refused for a stale key refreshes the key and retries once', async () => {
  // Cookies are scoped by host, not port, so a DSH restart on a new port leaves the browser sending
  // the previous launch's control key. Without this, the panel's buttons stay broken until the user
  // reloads — which is exactly what happened after upgrading to 2.1.1.
  const app = client({
    rejectFirstWrite: true,
    handler: (action) => (action === 'update'
      ? { currentVersion: '2.1.1', latestVersion: '2.1.1', updateAvailable: false, status: 'ok', checkedAt: null, error: null }
      : undefined),
  })
  app.render()
  await settle()
  await click(app.render(), 'Check for updates')
  await settle()
  const text = flatten(app.render())
  assert.match(text, /latest version, 2\.1\.1/u, 'the retried request succeeded')
  assert.doesNotMatch(text, /Could not reach the registry/u)
  // The status route has to be read in between: that is what re-issues the cookie.
  const order = app.requests.map((request) => request.url.replace(/^.*\//u, ''))
  const writeIndex = order.indexOf('update')
  assert.ok(order.indexOf('status', writeIndex) > writeIndex, 'the key is refreshed after the refusal')
})

test('a write that fails for another reason is not retried', async () => {
  const app = client({ handler: () => undefined })
  app.render()
  await settle()
  await click(app.render(), 'Check for updates')
  await settle()
  const writes = app.requests.filter((request) => String(request.url).endsWith('/update'))
  assert.equal(writes.length, 1, 'a 400 is a real answer, not a stale key')
})

test('an available update offers a button, not just a command', async () => {
  // The command was the only way to act on an update notice. Someone who installed this from the
  // settings panel should not have to open a terminal to upgrade it.
  const app = client({
    data: {
      ...snapshot(),
      update: {
        currentVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'ok',
        checkedAt: null, error: null, upgradeHint: 'dsh plugin add dsh-plugin-health@2.1.0',
      },
    },
    handler: (action, body) => (body?.action === 'install'
      ? { phase: 'done', targetVersion: '2.1.0', previousVersion: '2.0.0', restartRequiredFrom: '2.0.0', log: [] }
      : undefined),
  })
  app.render()
  await settle()
  const view = app.render()
  const labels = buttons(view).map((node) => flatten(node).trim())
  assert.ok(labels.includes('Update now'), `expected an Update now button, got: ${labels.join(' | ')}`)
  // The command is still shown for anyone who prefers it.
  assert.match(flatten(view), /dsh-plugin-health@2\.1\.0/u)
})

test('clicking update installs and then asks for a restart', async () => {
  const app = client({
    data: {
      ...snapshot(),
      update: {
        currentVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'ok',
        checkedAt: null, error: null, upgradeHint: 'dsh plugin add dsh-plugin-health@2.1.0',
      },
    },
    handler: (action, body) => (body?.action === 'install'
      ? { phase: 'done', targetVersion: '2.1.0', previousVersion: '2.0.0', restartRequiredFrom: '2.0.0', log: [] }
      : undefined),
  })
  app.render()
  await settle()
  await click(app.render(), 'Update now')
  await settle()
  const sent = app.requests.find((request) => request.body?.action === 'install')
  assert.ok(sent, 'the click must ask the host to install')
  assert.equal(sent.body.version, '2.1.0', 'the exact version the check found')
  // The files are updated; the running host is not. Saying "updated" without that would be a lie.
  assert.match(flatten(app.render()), /restart DSH/u)
})

test('a failed install shows the package manager\'s reason and offers a retry', async () => {
  const app = client({
    data: {
      ...snapshot(),
      update: { currentVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'ok', checkedAt: null, error: null },
    },
    handler: (action, body) => (body?.action === 'install'
      ? { phase: 'failed', error: 'the package manager exited with code 1', log: ['ERR_PNPM_FETCH_404 not found'], targetVersion: '2.1.0' }
      : undefined),
  })
  app.render()
  await settle()
  await click(app.render(), 'Update now')
  await settle()
  const text = flatten(app.render())
  assert.match(text, /Update failed/u)
  assert.match(text, /FETCH_404/u, 'the reason must be visible, not just an exit code')
  assert.ok(buttons(app.render()).some((node) => /Try again/u.test(flatten(node))), 'a retry must be offered')
})
