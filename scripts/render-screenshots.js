// Render the plugin's real settings section to a screenshot, without a running host.
//
// Render the component tree, its scoped stylesheet and semantic attributes using a small hook
// stub. This produces static screenshots only; browser interaction checks verify real React,
// keyboard focus and animation separately.
//
// This exists because the README shipped screenshots from before the sidebar and rescue flow were
// rewritten, and there is no way to attach to a running host from here. Regenerate with:
//
//   node scripts/render-screenshots.js <state> <lang> <out.html> [daily|advanced|developer]
//
// then point a headless browser at the produced file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'

const [state = 'finding', language = 'en', out = 'docs/images/.render.html', view = 'daily'] = process.argv.slice(2)
if (!['daily', 'advanced', 'developer'].includes(view)) throw new Error(`unknown view: ${view}`)

const clientSource = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')

// --- snapshot states ------------------------------------------------------------------------
//
// Each one is what the status route would return at that point in the flow.

const host = '0.2.1-rc.5'
const plugin = { name: 'dsh-thinking-levels', version: '4.4.9', requirements: { 'engines.dsh': '0.2.1-rc.4' }, id: null }

const base = {
  generatedAt: '2026-11-03T13:00:00Z',
  runtimeVersion: host,
  profile: 'desktop',
  home: 'C:\\Users\\Eason\\.dsh',
  scanned: { plugins: { total: 19 } },
  repairKey: 'k'.repeat(48),
}

const SNAPSHOTS = {
  // A rejected plugin whose review has not started: the section offers to find out whether it can
  // be saved, which is the thing the tool exists for.
  finding: {
    ...base,
    issues: [{
      id: 'plugin-incompatible',
      severity: 'warn',
      title: `Installed plugin is incompatible with dsh ${host}: dsh-thinking-levels`,
      detail: 'Unmet requirements: engines.dsh 0.2.1-rc.4',
      fix: 'Update the plugin, or check whether it can be saved and grant an exact-version exemption.',
      autoFixable: false,
    }],
    summary: { error: 0, warn: 1 },
    incompatible: 1,
    rescuable: [plugin],
    rescues: [],
  },

  // After the rehearsal booted: the exemption exists, and the section shows it can be revoked.
  exempt: {
    ...base,
    issues: [],
    summary: { error: 0, warn: 0 },
    incompatible: 0,
    rescuable: [],
    rescues: [{
      key: `dsh-thinking-levels@4.4.9@${host}`,
      name: 'dsh-thinking-levels',
      version: '4.4.9',
      runtimeVersion: host,
      active: true,
      stale: false,
      installedVersion: '4.4.9',
    }],
  },

  // The sidebar chip, which is what a user sees without opening anything: it renders only when a
  // problem exists, which is why it cannot be captured from a healthy profile.
  sidebar: {
    ...base,
    issues: [
      { id: 'plugin-incompatible', severity: 'warn', title: 'one', detail: '', fix: '', autoFixable: false },
      { id: 'plugin-incompatible-2', severity: 'warn', title: 'two', detail: '', fix: '', autoFixable: false },
    ],
    summary: { error: 0, warn: 2 },
    incompatible: 2,
    rescuable: [plugin],
    rescues: [],
  },
}

const snapshot = SNAPSHOTS[state]
if (snapshot === undefined) throw new Error(`unknown state: ${state}; try ${Object.keys(SNAPSHOTS).join(', ')}`)

// --- a React stub sufficient for this bundle ------------------------------------------------
const slots = new Map(), dictionaries = new Map(), instances = new Map()
let active, pendingEffects = [], exports

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(initial) {
    const record = active, index = record.cursor++
    if (!(index in record.hooks)) record.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [record.hooks[index], (value) => {
      record.hooks[index] = typeof value === 'function' ? value(record.hooks[index]) : value
    }]
  },
  useRef(initial) {
    const record = active, index = record.cursor++
    if (!(index in record.hooks)) record.hooks[index] = { current: initial }
    return record.hooks[index]
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
    return (dict?.[language]?.[key] ?? dict?.en?.[key] ?? key)
      .replace(/\{(\w+)\}/gu, (match, name) => params[name] ?? match)
  },
}

const ctx = {
  locale,
  effect: (fn) => fn(),
  // The module asks for a `layout` dependency to register the sidebar chip. Handing back the main
  // context there would silently drop the registration, so the sidebar slot gets its own store.
  inject: (deps, fn) => fn(Array.isArray(deps) && deps.includes('layout') ? layoutCtx : ctx),
  get: () => undefined,
  slots: {
    inject: (_n, fn) => fn(),
    register: (meta, component) => { slots.set(meta.id, { meta, component }); return () => slots.delete(meta.id) },
  },
}

const layoutSlots = new Map()
const layoutCtx = {
  locale,
  effect: (fn) => fn(),
  inject: (_n, fn) => fn(layoutCtx),
  get: () => undefined,
  layout: { selectPanel: () => { throw new Error('settings is a modal, not a main panel') } },
  slots: {
    inject: (_n, fn) => fn(),
    register: (meta, component) => { layoutSlots.set(meta.id, { meta, component }); return () => layoutSlots.delete(meta.id) },
  },
}

runInNewContext(clientSource, {
  AbortController, setTimeout, clearTimeout,
  window: {
    __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => React) } },
    localStorage: { getItem: (key) => key === 'dsh-plugin-health:view' ? view : null },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/status') ? snapshot : {}),
  }),
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

function render() {
  const { meta, component } = slots.get('plugin-health')
  const props = { ...meta.inject?.(), ...(meta.locale ? { t: locale.bind(meta.locale) } : {}) }
  const tree = expand(React.createElement(component, props), 'plugin-health')
  const effects = pendingEffects
  pendingEffects = []
  effects.forEach((effect) => effect())
  return tree
}

/** Render the sidebar chip, which lives in its own slot and never appears in a healthy profile. */
function renderSidebar() {
  const entry = layoutSlots.get('plugin-health-alert')
  if (entry === undefined) throw new Error('the sidebar alert was not registered for this state')
  const props = { ...entry.meta.inject?.(), ...(entry.meta.locale ? { t: locale.bind(entry.meta.locale) } : {}) }
  const tree = expand(React.createElement(entry.component, props), 'plugin-health-alert')
  const effects = pendingEffects
  pendingEffects = []
  effects.forEach((effect) => effect())
  return tree
}

// --- serialise the tree to HTML --------------------------------------------------------------

const UNITLESS = new Set([
  'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink',
  'order', 'gridRow', 'gridColumn', 'columnCount', 'zoom',
])

function styleToCss(style) {
  if (!style || typeof style !== 'object') return ''
  const parts = []
  for (const [rawKey, value] of Object.entries(style)) {
    if (value === undefined || value === null || value === false) continue
    const key = rawKey.startsWith('--') ? rawKey : rawKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    const text = typeof value === 'number' && !UNITLESS.has(rawKey) && !rawKey.startsWith('--') ? `${value}px` : String(value)
    parts.push(`${key}:${text}`)
  }
  return parts.length === 0 ? '' : ` style="${escapeAttr(parts.join(';'))}"`
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr'])
const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'required', 'multiple', 'open', 'checked', 'selected', 'readOnly', 'autoFocus', 'inert'])
const SCALAR_ATTRS = new Set([
  'id', 'className', 'htmlFor', 'title', 'href', 'target', 'rel', 'download', 'type', 'name',
  'role', 'tabIndex', 'placeholder', 'maxLength', 'minLength', 'min', 'max', 'step', 'pattern',
  'autoComplete', 'inputMode', 'rows', 'cols', 'width', 'height', 'src', 'alt',
])

function toHtml(node, selectedValues) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeText(node)
  if (typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(child => toHtml(child, selectedValues)).join('')

  const tag = typeof node.type === 'string' ? node.type : 'div'
  const props = node.props ?? {}
  let attrs = styleToCss(props.style)

  // Preserve the attributes used by scoped CSS, disclosure visibility and accessible controls.
  // Do not serialize callbacks, React keys or ref objects as HTML.
  for (const [name, value] of Object.entries(props)) {
    if (name === 'selected' && tag === 'option' && selectedValues !== undefined) continue
    if (BOOLEAN_ATTRS.has(name)) {
      if (value === true || (name === 'inert' && value === '')) attrs += ` ${name.toLowerCase()}`
    } else if ((SCALAR_ATTRS.has(name) || /^(?:aria|data)-[a-z0-9-]+$/u.test(name)) && value != null) {
      const htmlName = name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : name.toLowerCase()
      attrs += ` ${htmlName}="${escapeAttr(value)}"`
    }
  }
  const value = props.value ?? props.defaultValue
  if (tag === 'select') {
    selectedValues = value === undefined ? undefined : new Set((Array.isArray(value) ? value : [value]).map(String))
  } else if (tag === 'input' || tag === 'option' || tag === 'button') {
    if (value !== undefined) attrs += ` value="${escapeAttr(value)}"`
  }
  if (tag === 'option' && selectedValues?.has(String(value ?? node.children.join('')))) attrs += ' selected'

  // <style> is raw text in HTML. Entity-escaping its selectors breaks combinators, quotes and
  // CSS variables; only neutralize a literal closing tag. The stylesheet comes from client.js.
  const inner = tag === 'style'
    ? node.children.join('').replace(/<\/style/giu, '<\\/style')
    : tag === 'textarea' && value !== undefined
      ? escapeText(value)
      : node.children.map(child => toHtml(child, selectedValues)).join('')
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`
  return `<${tag}${attrs}>${inner}</${tag}>`
}

// Two passes: the first schedules effects (the section fetches its status), the second renders the
// settled state. Rendering once would capture the loading placeholder.
render()
setTimeout(() => {
  // The sidebar chip is a different slot with a different frame: a narrow column on a sidebar
  // background, rather than the settings pane.
  if (state === 'sidebar') {
    const chip = toHtml(renderSidebar())
    const page = `<!doctype html>
<html lang="${language === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #f6f7f8; }
  body { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2328; }
  .sidebar { width: 236px; padding: 12px 12px 14px; }
  button { font: inherit; }
</style>
</head>
<body>
<div class="sidebar">
  ${chip}
</div>
</body>
</html>
`
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, page, 'utf8')
    console.log(`  ${state}/${language} -> ${out} (${Math.round(page.length / 1024)}KB)`)
    return
  }

  const tree = render()

  // The section is designed for a host settings pane; these frame it the way DSH does, so the image
  // is not a floating fragment on a blank page.
  const page = `<!doctype html>
<html lang="${language === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #ffffff; }
  body { font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2328; }
  /* The section is already titled, so the frame only contributes padding — a second heading would
     read as a duplicated page header in the image. */
  .pane { width: 680px; padding: 20px 24px 22px; }
  button { font: inherit; }
</style>
</head>
<body>
<div class="pane">
  ${toHtml(tree)}
</div>
</body>
</html>
`
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, page, 'utf8')
  console.log(`  ${state}/${language} -> ${out} (${Math.round(page.length / 1024)}KB)`)
}, 10)
