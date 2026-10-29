// Render the settings section and print the visible text, so the layout can be reviewed
// without starting a host or taking a screenshot. Read-only: nothing is executed but the
// bundle's own render functions, and no network or process is touched.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const clientSource = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')
const language = process.argv[2] === 'zh' ? 'zh' : 'en'

const snapshot = {
  issues: [
    {
      id: 'plugin-incompatible', severity: 'warn',
      title: 'Installed plugin is incompatible with dsh 0.2.1-rc.4: @nanmicoder/dsh-agent-teams@0.1.27',
      detail: 'Unmet requirements: @deepseek-ai/dsh-tools 0.2.1-rc.3 || 0.2.1-rc.2', fix: 'Update the plugin or grant an exact-version exemption.', autoFixable: false,
    },
  ],
  summary: { error: 0, warn: 1 }, scanned: { plugins: { total: 15 } },
  repairKey: 'k'.repeat(48), generatedAt: '2026-10-29T12:00:00Z', runtimeVersion: '0.2.1-rc.4',
  profile: 'desktop', home: 'C:\\Users\\Eason\\.dsh', incompatible: 1,
  rescuable: [{ name: '@nanmicoder/dsh-agent-teams', version: '0.1.27', requirements: {}, id: null }],
  rescues: [{ key: 'x@1', name: 'dsh-session-recall', version: '0.1.0', runtimeVersion: '0.2.1-rc.3', active: true, stale: false, installedVersion: '0.1.0' }],
  repairKeyValue: 'k',
}

const slots = new Map(), dictionaries = new Map(), instances = new Map()
let active, pendingEffects = [], exports
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
  locale, effect: (fn) => fn(), inject: (_n, fn) => fn(ctx), get: () => undefined,
  slots: { inject: (_n, fn) => fn(), register: (meta, component) => { slots.set(meta.id, { meta, component }); return () => slots.delete(meta.id) } },
}
runInNewContext(clientSource, {
  window: { __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => React) } } },
  navigator: { clipboard: { writeText: async () => {} } },
  setInterval: () => 0, clearInterval: () => {},
  fetch: async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('/status') ? snapshot : {}) }),
})
exports.apply(ctx)
function expand(node, path) {
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const id = `${path}/${node.type.name}`
    if (!instances.has(id)) instances.set(id, { hooks: [] })
    active = instances.get(id); active.cursor = 0
    return expand(node.type(node.props), id)
  }
  return { ...node, children: node.children.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`)) }
}
const render = () => {
  const { meta, component } = slots.get('plugin-health')
  const props = { ...meta.inject?.(), ...(meta.locale ? { t: locale.bind(meta.locale) } : {}) }
  const tree = expand(React.createElement(component, props), 'plugin-health')
  const effects = pendingEffects; pendingEffects = []
  effects.forEach((effect) => effect())
  return tree
}

// Print a wireframe: indentation follows nesting, and each element's own text is shown once.
const lines = []
function walk(node, depth) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node !== 'object') {
    const text = String(node).trim()
    if (text !== '' && text !== 'true' && text !== 'false') lines.push(`${'  '.repeat(depth)}${text}`)
    return
  }
  const tag = node.type === 'button' ? '[button]' : node.type === 'a' ? '[link]' : null
  const own = node.children.filter(child => typeof child !== 'object')
  if (tag !== null) {
    const label = node.children.map(child => (typeof child === 'object' ? '' : String(child))).join(' ').trim()
    lines.push(`${'  '.repeat(depth)}${tag} ${label}`)
    return
  }
  for (const child of node.children) walk(child, depth + (typeof child === 'object' ? 1 : 0))
}

const first = render()
setTimeout(() => {
  const tree = render()
  walk(tree, 0)
  console.log(`\n===== ${language.toUpperCase()} settings section =====\n`)
  console.log(lines.join('\n'))
}, 10)
