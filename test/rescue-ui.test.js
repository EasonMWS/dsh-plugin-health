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
function client({ data = snapshot(), handler, statusSequence, rejectFirstWrite = false, storage = new Map(), documentOverride } = {}) {
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
  AbortController, setTimeout, clearTimeout,
    URL,
    URLSearchParams,
    window: {
      __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => React) } },
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    },
    navigator: {
      clipboard: { writeText: async (value) => { requests.push({ url: 'clipboard', body: value }) } },
      platform: 'Win32',
      userAgent: 'Electron/44.7.0',
    },
    // Minimal DOM. A test that needs the shell's real settings button passes its own.
    document: documentOverride ?? {
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
      if (url.endsWith('/status') || url.endsWith('/status?fresh=1')) {
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
    setData: (next) => { data = next },
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
  if (node === null || node === undefined || typeof node === 'boolean' || node.type === 'style' || node.props?.hidden || node.props?.['aria-hidden'] === true) return ''
  if (typeof node !== 'object') return String(node)
  return node.children.map(flatten).join(' ')
}
const findAll = (node, predicate, out = []) => {
  if (!node || typeof node !== 'object' || node.type === 'style' || node.props?.hidden || node.props?.['aria-hidden'] === true) return out
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

const card = (app, plugin = PLUGIN) => {
  const found = findAll(app.render(), node => node.props['data-plugin'] === `${plugin.name}@${plugin.version}`)[0]
  assert.ok(found, `missing rescue card: ${plugin.name}@${plugin.version}`)
  return found
}
const switchView = (app, value) => click(app.render(), { daily: 'Daily', advanced: 'Advanced', developer: 'Developer' }[value])
const trialRequests = app => app.requests.filter(request => request.url.endsWith('/rehearse'))
async function runTrial(app, { plugin = PLUGIN, review = 'Review startup check', confirm = 'I trust this plugin; run the check' } = {}) {
  const before = trialRequests(app).length
  await click(card(app, plugin), review)
  assert.equal(trialRequests(app).length, before, 'reviewing the warning must not execute the plugin')
  await click(card(app, plugin), confirm)
}

for (const view of ['daily', 'advanced', 'developer']) {
  test(`${view}: startup and repeated checks require confirmation; cancelling executes nothing`, async () => {
    const app = client({
      storage: new Map([['dsh-plugin-health:view', view]]),
      handler: action => action === 'rehearse'
        ? { verdict: 'inconclusive', canApply: false, messageKey: 'rescueVerdictInconclusive' }
        : undefined,
    })
    app.render(); await settle()
    await click(card(app), 'Review startup check')
    const warning = card(app)
    assert.match(flatten(warning), /downloads, installs and executes plugin code/u)
    assert.match(flatten(warning), /does not restrict access to files, networks or other programs/u)
    assert.match(flatten(warning), /Cancel if the source is unknown/u)
    assert.equal(trialRequests(app).length, 0)
    await click(warning, 'Cancel startup check')
    assert.equal(trialRequests(app).length, 0)
    assert.doesNotMatch(flatten(card(app)), /Confirm you trust the plugin before running it/u)

    await runTrial(app)
    assert.deepEqual(trialRequests(app).map(request => request.body), [{ plugin: PLUGIN.name, version: PLUGIN.version }])
    assert.match(flatten(card(app)), /trial was inconclusive.*No (?:version exemption was written|startup permission was saved)/u)
    assert.doesNotMatch(flatten(card(app)), /cannot be saved|Nothing was changed|Allow startup next time|Exempt temporarily/u)
    await click(card(app), 'Check again')
    assert.equal(trialRequests(app).length, 1, 'a repeat check must wait for fresh confirmation')
    assert.match(flatten(card(app)), /Confirm you trust the plugin before running it/u)
    await click(card(app), 'Cancel startup check')
    assert.equal(trialRequests(app).length, 1)
    assert.match(flatten(card(app)), /trial was inconclusive/u)

    await click(card(app), 'Check again')
    const confirm = buttons(card(app)).find(node => flatten(node).trim() === 'I trust this plugin; run the check')
    const running = confirm.props.onClick()
    await confirm.props.onClick() // An already queued second click must not run the code twice.
    await running
    assert.equal(trialRequests(app).length, 2)
  })
}

test('two plugin trials keep out-of-order results and startup permissions on the matching card', async () => {
  const other = { ...PLUGIN, name: 'other-plugin', id: 'other' }
  const pending = new Map(), applied = []
  const app = client({
    data: snapshot({ rescuable: [PLUGIN, other] }),
    handler: (action, body) => {
      if (action === 'rehearse') return new Promise(resolve => pending.set(body.plugin, resolve))
      if (action === 'apply') {
        applied.push(body)
        return { applied: true, verdict: 'runs', messageKey: 'rescueVerdictRuns' }
      }
    },
  })
  app.render(); await settle()
  const first = runTrial(app)
  await settle()
  assert.match(flatten(card(app)), /Installing and starting/u)
  assert.ok(buttons(card(app, other)).some(node => flatten(node).trim() === 'Review startup check'))
  const second = runTrial(app, { plugin: other })
  await settle()
  pending.get(other.name)({ verdict: 'broken', canApply: false, messageKey: 'rescueVerdictBrokenWhy' })
  await second
  assert.match(flatten(card(app)), /Installing and starting/u)
  assert.match(flatten(card(app, other)), /Did not start in this trial/u)
  pending.get(PLUGIN.name)({ verdict: 'runs', canApply: true, messageKey: 'rescueVerdictRuns', hostVersion: '0.2.1-rc.4' })
  await first
  assert.match(flatten(card(app)), /Passed the standalone startup check/u)
  assert.doesNotMatch(flatten(card(app, other)), /Passed the standalone startup check|Allow startup next time/u)

  switchView(app, 'developer')
  assert.ok(buttons(card(app)).some(node => flatten(node).trim() === 'Exempt temporarily'))
  assert.doesNotMatch(flatten(card(app, other)), /Exempt temporarily/u)
  switchView(app, 'daily')
  await click(card(app), 'Allow startup next time')
  assert.match(flatten(card(app)), /legacy-plugin@1.0.0/u)
  assert.doesNotMatch(flatten(card(app, other)), /Confirm this version may start/u)
  await click(card(app), 'Confirm startup permission')
  assert.deepEqual(applied, [{ plugin: PLUGIN.name, version: PLUGIN.version }])
  assert.match(flatten(card(app)), /Allowed to start next time/u)
  assert.doesNotMatch(flatten(card(app, other)), /Allowed to start next time/u)
})

for (const changed of ['version', 'profile']) {
  test(`a changed ${changed} does not inherit the previous successful trial`, async () => {
    const app = client({ handler: action => action === 'rehearse'
      ? { verdict: 'runs', canApply: true, messageKey: 'rescueVerdictRuns' } : undefined })
    app.render(); await settle()
    await runTrial(app)
    assert.match(flatten(card(app)), /Passed the standalone startup check/u)
    const nextPlugin = changed === 'version' ? { ...PLUGIN, version: '2.0.0' } : PLUGIN
    const next = snapshot({ rescuable: [nextPlugin] })
    if (changed === 'profile') next.profile = 'another-setup'
    app.setData(next)
    await click(app.render(), 'Rescan')
    const fresh = card(app, nextPlugin)
    assert.ok(buttons(fresh).some(node => flatten(node).trim() === 'Review startup check'))
    assert.doesNotMatch(flatten(fresh), /Passed the standalone startup check|Allow startup next time/u)
    assert.equal(trialRequests(app).length, 1)
    assert.equal(app.requests.filter(request => request.url.endsWith('/apply')).length, 0)
  })
}

test('a failed report search is not presented as an empty successful search', async () => {
  let available = false
  const app = client({ handler: action => {
    if (action === 'rehearse') return { verdict: 'broken', canApply: false, messageKey: 'rescueVerdictBrokenWhy' }
    if (action === 'report') return {
      checked: available, error: available ? null : 'GitHub responded 503', existing: [],
      newIssueUrl: 'https://github.com/o/r/issues/new', title: 't', body: 'b',
    }
  } })
  app.render(); await settle()
  await runTrial(app)
  await click(card(app), 'Look for similar reports')
  let view = card(app)
  assert.match(flatten(view), /This search did not complete/u)
  assert.doesNotMatch(flatten(view), /Nobody has reported|No matching reports|feedback draft is ready/u)
  assert.equal(links(view).some(node => node.props.href?.endsWith('/issues/new')), false)
  available = true
  await click(view, 'Look for similar reports')
  view = card(app)
  assert.match(flatten(view), /No matching reports found in this search/u)
  assert.ok(links(view).some(node => node.props.href === 'https://github.com/o/r/issues/new'))
})

test('the settings preview sends the target and displays the version mismatch separately from activation', async () => {
  const review = {
    profile: 'desktop', currentVersion: '0.2.1-rc.4', targetVersion: '0.2.1-rc.4',
    packages: [{ name: 'legacy-plugin', version: '1.0.0', declaration: { state: 'compatible' } }],
    activation: [{ id: 'legacy', name: 'legacy-plugin', state: 'active' }], findings: [], limits: [],
  }
  const app = client({
    data: { ...snapshot({ rescuable: [] }), review },
    handler: action => {
      if (action !== 'status?target=0.2.1-rc.5&fresh=1') return
      return { review: { ...review, targetVersion: '0.2.1-rc.5', packages: [
        { ...review.packages[0], declaration: { state: 'incompatible', requirements: { 'engines.dsh': '0.2.1-rc.4' } } },
      ] } }
    },
  })
  app.render()
  await settle()
  switchView(app, 'advanced')
  // Two previews exist now. The compact UpgradePreview has no package list, so address the form
  // that belongs to the full ProfileReview: it is the one whose card carries the review title.
  const inputs = findAll(app.render(), node => node.type === 'input')
  inputs[inputs.length - 1].props.onChange({ target: { value: '0.2.1-rc.5' } })
  // Re-read the tree: the change above re-renders, so nodes captured before it carry stale props.
  const forms = findAll(app.render(), node => node.type === 'form')
  await forms[forms.length - 1].props.onSubmit({ preventDefault() {} })
  app.render() // Flush the effect that reveals mismatches.
  const entries = buttons(app.render()).find(node => flatten(node).includes('Other loader entries'))
  entries.props.onClick()
  const view = flatten(app.render())
  assert.match(view, /DSH 0\.2\.1-rc\.5 · Packages with assessed declarations: 1 · Package mismatches without exemptions: 1/u)
  assert.match(view, /legacy-plugin@1.0.0\s+Support not listed for this version/u)
  assert.match(view, /legacy-plugin\s+Running\s+legacy/u)
})

test('the view keeps daily recovery visible, remembers the selected level and shows live failures', async () => {
  const storage = new Map()
  const failed = { id: 'runtime-plugin', name: 'dsh-runtime-plugin', state: 'failed', diagnostic: { kind: 'duplicate-tool', tool: 'archive' } }
  const data = {
    ...snapshot({ rescuable: [] }),
    liveReview: {
      sampledAt: '2026-10-29T12:00:00Z', entries: [failed],
      changes: [{ ...failed, before: 'active', after: 'failed', sampledAt: '2026-10-29T12:00:00Z' }],
    },
    review: { profile: 'desktop', targetVersion: '0.2.1-rc.4', packages: [], findings: [], limits: [] },
  }
  const app = client({ data, storage })
  app.render()
  await settle()
  const daily = app.render()
  assert.equal(daily.props['data-view'], 'daily')
  assert.match(flatten(daily), /Activation failed 1.*feature name archive is used more than once/u)
  assert.doesNotMatch(flatten(daily), /Recent startup changes|Check upgrade impact|Download runtime evidence/u)
  assert.equal(app.findAlert()?.props.count, 1)
  switchView(app, 'advanced')
  buttons(app.render()).find(node => flatten(node).includes('Recent startup changes')).props.onClick()
  const advanced = app.render()
  assert.match(flatten(advanced), /Recent startup changes.*Running → Activation failed.*Check upgrade impact/u)
  assert.doesNotMatch(flatten(advanced), /Download runtime evidence/u)
  switchView(app, 'developer')
  assert.match(flatten(app.render()), /dsh-plugin-health review --json.*Download runtime evidence/u)
  assert.equal(client({ data, storage }).render().props['data-view'], 'developer')
})

test('the rescue panel renders the plugin and one check button', async () => {
  const app = client()
  const tree = app.render()
  await settle()
  const view = app.render()
  assert.match(flatten(view), /legacy-plugin/u)
  assert.match(flatten(view), /Plugin version does not match/u, 'the section heading is the compatibility one')
  assert.deepEqual(
    buttons(card(app)).map(node => flatten(node).trim()),
    ['Review startup check'],
  )
})

test('a rehearsal that boots offers the exemption, not a dead end', async () => {
  const app = client({
    handler: action => action === 'rehearse'
      ? { verdict: 'runs', level: 'ok', messageKey: 'rescueVerdictRuns', canApply: true, hostVersion: '0.2.1-rc.4' }
      : undefined,
  })
  app.render(); await settle()
  await runTrial(app)
  await settle()
  const view = app.render()
  assert.match(flatten(view), /Passed the standalone startup check.*started in this trial.*other features and any malicious behavior have not been checked/u)
  assert.deepEqual(buttons(card(app)).map(node => flatten(node).trim()), ['Allow startup next time'])
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
  await runTrial(app); await settle()
  // The first click only reveals the consequences; nothing may be written yet.
  await click(app.render(), 'Allow startup next time'); await settle()
  assert.equal(written.length, 0, 'no write may happen on the click that reveals the trade-off')
  const confirmView = app.render()
  assert.match(flatten(confirmView), /Confirm this version may start/u)
  assert.match(flatten(confirmView), /safety are unverified/u, 'the limit is stated in the confirmation itself')
  await click(confirmView, 'Confirm startup permission'); await settle()
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
  await runTrial(app); await settle()
  await click(app.render(), 'Allow startup next time'); await settle()
  await click(app.render(), 'Cancel'); await settle()
  const view = app.render()
  assert.doesNotMatch(flatten(view), /Confirm this version may start/u)
  assert.deepEqual(buttons(card(app)).map(node => flatten(node).trim()), ['Allow startup next time'])
  assert.equal(app.requests.filter(request => request.url.endsWith('/apply')).length, 0)
})

test('a plugin that cannot boot offers exactly two decisions and no exemption', async () => {
  const app = client({
    handler: action => action === 'rehearse'
      ? { verdict: 'broken', level: 'error', messageKey: 'rescueVerdictBrokenWhy', canApply: false }
      : undefined,
  })
  app.render(); await settle()
  await runTrial(app); await settle()
  const view = app.render()
  // An exemption for a plugin that cannot boot would hide a real breakage behind a gate that
  // no longer warns, so the button must not exist at all.
  assert.doesNotMatch(flatten(view), /Allow startup next time/u)
  assert.match(flatten(view), /Turn it off, keep using DSH/u)
  assert.match(flatten(view), /Let AI try to fix it/u)
  const labels = buttons(view).map(node => flatten(node).trim())
  assert.ok(labels.includes('Turn off'))
  assert.ok(labels.includes('Prepare a problem summary'))
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
  await runTrial(app); await settle()
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
  await runTrial(app); await settle()
  await click(app.render(), 'Prepare a problem summary'); await settle()
  const view = app.render()
  assert.match(flatten(view), /Problem summary ready, not sent/u)
  assert.match(flatten(view), /C:\\dsh\\handoff/u)
  // Copying is a separate, explicit click — the brief existing is not consent to touch the clipboard.
  assert.equal(app.requests.filter(request => request.url === 'clipboard').length, 0)
  await click(view, 'Copy problem summary'); await settle()
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
  await runTrial(app); await settle()
  await click(app.render(), 'Look for similar reports'); await settle()
  const view = app.render()
  assert.match(flatten(view), /already reported/u)
  assert.match(flatten(view), /#7/u)
  assert.doesNotMatch(flatten(view), /Open the feedback page/u, 'a duplicate must not be encouraged')
  assert.equal(links(view).find(node => flatten(node).includes('#7')).props.href, 'https://github.com/o/r/issues/7')
})

test('report links reject executable schemes, credentials and lookalike hosts', async () => {
  const urls = ['javascript:alert(1)', 'data:text/html,bad', 'https://github.com.evil.test/o/r/issues/7',
    'https://name:secret@github.com/o/r/issues/7', 'https://github.com/o/r/issues/7\n']
  for (const url of urls) {
    const app = client({ handler: action => action === 'rehearse'
      ? { verdict: 'broken', canApply: false }
      : action === 'report' ? { existing: [{ number: 7, title: '<script>untrusted</script>', url }] } : undefined })
    app.render(); await settle()
    await runTrial(app); await settle()
    await click(app.render(), 'Look for similar reports'); await settle()
    const link = links(app.render()).find(node => flatten(node).includes('#7'))
    assert.equal(link.props.href, undefined, url)
    assert.equal(link.props.dangerouslySetInnerHTML, undefined)
  }
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
  assert.match(flatten(view), /Plugins allowed to try starting/u)
  assert.match(flatten(view), /Installed version changed to 1\.1\.0/u, 'the local version changed; this does not claim an upstream fix')
  await click(view, 'Cancel permission'); await settle()
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
  await runTrial(app); await settle()
  await click(app.render(), 'Allow startup next time'); await settle()
  await click(app.render(), 'Confirm startup permission'); await settle()
  assert.match(flatten(app.render()), /This operation did not complete/u)
  assert.doesNotMatch(flatten(app.render()), /no script for apply/u)
  await click(app.render(), 'View diagnostic details')
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
  assert.match(flatten(first), /插件版本不合适/u)
  await runTrial(app, { review: '查看试运行说明', confirm: '我信任此插件，开始试运行' }); await settle()
  assert.match(flatten(app.render()), /已通过独立启动检查.*本次检查中启动了.*还没有检查全部功能.*没有判断它是否有恶意行为/u)
})

// --- the sidebar alert must actually open something -----------------------------------

test('the sidebar alert opens settings by pressing the shell control, not by a synthetic key', async () => {
  // A user reported the 查看 button doing nothing. Two causes in sequence: first it called
  // layout.selectPanel('settings'), which is not a panel key; then it dispatched a synthetic
  // Ctrl+Comma, which the desktop build ignores (shortcuts arrive natively) and the web build treats
  // as a toggle. The working path is pressing the shell's own button.
  //
  // Markup from @deepseek-ai/dsh-client-ui-settings-general 0.2.1-rc.4, lib/client.js:451-462.
  const clicked = []
  const settingsButton = {
    disabled: false,
    getClientRects: () => [{}],
    closest: () => null,
    click() { clicked.push('settings') },
  }
  // The dialog appears after the click, as DSH mounts it asynchronously.
  let dialogOpen = false
  const documentOverride = {
    activeElement: undefined,
    body: { dispatchEvent: () => true },
    title: '',
    querySelectorAll: (selector) => {
      if (selector === 'button[aria-haspopup="dialog"][aria-label="Settings"]') {
        return dialogOpen ? [] : [settingsButton]
      }
      if (selector.includes('data-shortcut-modal')) return dialogOpen ? [{ getClientRects: () => [{}] }] : []
      return []
    },
  }
  const originalClick = settingsButton.click
  settingsButton.click = () => { originalClick(); setTimeout(() => { dialogOpen = true }, 20) }

  const app = client({
    data: { ...snapshot(), issues: [{ id: 'x', severity: 'warn', title: 'w', detail: 'd', fix: 'f' }] },
    documentOverride,
  })
  app.render()
  await settle()
  await settle()

  assert.equal(app.keyEvents.length, 0, 'nothing is dispatched until the user clicks')

  const alert = app.findAlert()
  assert.ok(alert, 'the sidebar alert should be registered when there are warnings')
  assert.equal(typeof alert.props.open, 'function', 'the alert must expose an open callback')

  let reported
  alert.props.open((ok) => { reported = ok })
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.deepEqual(clicked, ['settings'], 'it must press the shell settings control')
  assert.equal(app.keyEvents.length, 0, 'and must not synthesise a keyboard shortcut')
  assert.equal(reported, true, 'the dialog appeared, so the outcome is success')
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
  const anchor = links(view).find((node) => /Community compatibility/u.test(flatten(node)))
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
  assert.match(text, /社区兼容表/u)
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

test('update checking and installation cannot overwrite one another or submit twice', async () => {
  let finishCheck, finishInstall
  const update = { currentVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'ok' }
  const app = client({ data: { ...snapshot(), update }, handler: (action, body) => {
    if (action !== 'update') return
    return new Promise(resolve => { if (body.action === 'install') finishInstall = resolve; else finishCheck = resolve })
  } })
  app.render(); await settle()
  const checking = click(app.render(), 'Check for updates')
  await settle()
  const installButton = buttons(app.render()).find(node => flatten(node).trim() === 'Update now')
  assert.equal(installButton.props.disabled, true)
  await installButton.props.onClick() // A queued same-tick click is blocked by the hook too.
  assert.equal(app.requests.filter(request => request.body?.action === 'install').length, 0)
  finishCheck(update); await checking
  const installing = click(app.render(), 'Update now')
  await settle()
  const checkButton = buttons(app.render()).find(node => flatten(node).trim() === 'Check for updates')
  assert.equal(checkButton.props.disabled, true)
  await checkButton.props.onClick()
  assert.match(flatten(app.render()), /Updating…/u)
  assert.equal(app.requests.filter(request => request.url.endsWith('/update')).length, 2)
  finishInstall({ phase: 'done', targetVersion: '2.1.0' }); await installing
  assert.match(flatten(app.render()), /restart DSH/u)
})
