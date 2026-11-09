/**
 * Render a compatibility matrix as a standalone HTML page.
 *
 * The matrix already knows, for every plugin and every host version, whether the declared ranges
 * admit that host. This turns that into a page a user can be sent a link to: one row per plugin, one
 * column per host version, a category from the community catalog, and the date the published version
 * went out — so "this plugin is marked incompatible" reads differently on something released last
 * week than on something untouched since two host lines ago.
 *
 * Everything is inlined — styles, script and data — because it is deployed as a static file with no
 * build step, and because a single self-contained file is the only thing GitHub Pages will serve
 * without surprises. A few thousand rows is small enough that client-side filtering is instant.
 *
 * **Language.** The page ships English in the HTML (so a crawler and a first paint both get real
 * text) and carries a second dictionary for Chinese, swapped in place by a toggle. Every visible
 * string is marked with `data-i18n`; anything that interpolates a number carries the number in a data
 * attribute instead, so switching language never has to re-fetch or re-render the table.
 *
 * The page deliberately states what it does *not* know: a plugin missing from the index was never
 * tested, and "compatible" means the declared ranges admit the host, not that the plugin works.
 */

/** Escape text for HTML text nodes and attribute values. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * One cell's state, as a word rather than only a colour — colour alone fails for colour-blind
 * readers and for anyone reading a screenshot.
 * @param {object|undefined} result
 * @returns {{glyph: string, label: string, cls: string}}
 */
function cellState(result) {
  if (result === undefined) return { glyph: '–', label: 'not tested', cls: 'unknown' }
  if (result.compatible === true) return { glyph: '✓', label: 'compatible', cls: 'ok' }
  if (result.compatible === false) return { glyph: '✕', label: 'incompatible', cls: 'bad' }
  return { glyph: '?', label: 'unknown', cls: 'unknown' }
}

/**
 * Compact a timestamp to a day for display and sorting.
 * @param {string|undefined} iso
 * @returns {string} YYYY-MM-DD, or '' when absent or unparseable.
 */
function dayOf(iso) {
  if (typeof iso !== 'string') return ''
  const day = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/**
 * Every user-visible string, both languages. Numbers are interpolated at call time rather than
 * baked in, so a row does not have to be re-rendered when the language changes.
 */
const STRINGS = {
  en: {
    heading: 'DSH plugin compatibility',
    lede: 'DSH refuses to load a plugin when its declared version range excludes the host you run. This table checks every plugin in the community catalog against the current host versions, so you can tell before installing whether it will be rejected.',
    updated: 'Updated',
    checked: 'plugins checked',
    healthy: 'load on every host',
    rejected: 'rejected by at least one',
    rejectedOnLatest: 'rejected on the latest host',
    acceptedOnLatest: 'accepted on the latest host',
    roleLatest: 'latest',
    rolePrevious: 'previous line',
    rolePreview: 'preview',
    ignoredTags: 'Older prerelease tags are left out: ',
    filterName: 'Filter by plugin name…',
    allCategories: 'All categories',
    onlyRejected: 'Only rejected',
    colPlugin: 'Plugin',
    colCategory: 'Category',
    colReleased: 'Released',
    colNotes: 'Notes',
    rejectedBy: 'rejected by',
    declared: 'declared',
    byHost: 'By host version',
    hostLine: 'of these plugins are rejected',
    accepted: 'accepted',
    empty: 'No plugin matches those filters.',
    caveatHead: 'Read this before relying on a row.',
    caveat: 'A tick means the plugin\'s declared ranges admit that host, so the installer will not reject it. It does not mean the plugin works, and it is not a security review. "Released" is the publish date of the version shown, which tells you whether the maintainer has been active on the current host line. A plugin that is missing was never checked. When a plugin is marked rejected the cause is usually a one-line range update in its package.json, which the maintainer has to ship — you cannot fix it locally.',
    sourceHead: 'Where this comes from.',
    source: 'The plugin list is the awesome-dsh-plugin community catalog, filtered to entries published on npm — {n} of them here. A plugin that only exists as a GitHub repo or a tarball cannot be checked and is not counted. Each row compares the plugin\'s own package.json declarations (engines.dsh, peer ranges) against the host versions in the column headers; no plugin code is executed and nothing is installed. That is why a tick means "the installer accepts it", not "it works". Rebuilt once a day.',
    generatedBy: 'Generated by',
    pluginIndex: 'plugin index',
    reportRow: 'report a wrong row',
    langLabel: 'Language',
    title: 'DSH plugin compatibility — which plugins work on which DSH version',
    description: 'Which DeepSeek Harness plugins load on which host version.',
    pluginsWord: 'plugins',
    tallyStamp: 'plugins',
    shownOf: 'of',
    categories: {
      ui: 'ui', tools: 'tools', session: 'session', workflow: 'workflow', dev: 'dev', model: 'model',
      usage: 'usage', memory: 'memory', notify: 'notify', theme: 'theme', remote: 'remote',
      skill: 'skill', fun: 'fun', security: 'security', browser: 'browser', git: 'git',
      vision: 'vision', docs: 'docs', market: 'market', voice: 'voice', identity: 'identity',
      agi: 'agi', wsl: 'wsl', uncategorized: 'uncategorized',
    },
  },
  zh: {
    heading: 'DSH 插件兼容性',
    lede: 'DSH 会拒绝加载声明范围不包含当前宿主版本的插件。这张表把社区目录里的每个插件都对着当前的宿主版本查了一遍，所以你可以在安装之前就知道它会不会被拒。',
    updated: '更新于',
    checked: '个插件已检查',
    healthy: '所有宿主都接受',
    rejected: '至少被一个宿主拒绝',
    rejectedOnLatest: '在最新版上被拒',
    acceptedOnLatest: '最新版接受',
    roleLatest: '最新',
    rolePrevious: '上一版本线',
    rolePreview: '预览',
    ignoredTags: '已忽略更旧的预发布 tag：',
    filterName: '按插件名筛选…',
    allCategories: '全部分类',
    onlyRejected: '只看被拒的',
    colPlugin: '插件',
    colCategory: '分类',
    colReleased: '发布日期',
    colNotes: '说明',
    rejectedBy: '被拒',
    declared: '声明',
    byHost: '按宿主版本',
    hostLine: '个插件被拒绝',
    accepted: '个接受',
    empty: '没有插件匹配当前筛选条件。',
    caveatHead: '看这一行之前，请先读这里。',
    caveat: '打勾表示插件的声明范围包含那个宿主版本，安装器不会拒绝它。这不代表插件能用，也不是安全审查。「发布日期」是当前显示版本的发布时间，可以据此判断作者是否还在维护。「没查到」的插件是从来没被检查过，不是通过。被标为拒绝的，原因通常是 package.json 里一行版本范围要改——这得作者发版，你在本地改不了。',
    sourceHead: '数据从哪来。',
    source: '插件列表来自 awesome-dsh-plugin 社区目录，只保留已发布到 npm 的条目——这里是 {n} 个。只在 GitHub 仓库或 tarball 上的插件无法检查，也不计入。每一行都是拿插件自己 package.json 里的声明（engines.dsh、peer 范围）和表头的宿主版本对比；不执行任何插件代码，也不安装任何东西。所以打勾代表「安装器会接受它」，不代表「它能用」。每天重建一次。',
    generatedBy: '由',
    pluginIndex: '插件索引',
    reportRow: '报错一行',
    langLabel: '语言',
    title: 'DSH 插件兼容性 — 哪些插件能在哪个 DSH 版本上用',
    description: '哪些 DeepSeek Harness 插件能在哪个宿主版本上加载。',
    pluginsWord: '个插件',
    tallyStamp: '个插件',
    shownOf: '/',
    categories: {
      ui: '界面', tools: '工具', session: '会话', workflow: '工作流', dev: '开发', model: '模型',
      usage: '用量', memory: '记忆', notify: '通知', theme: '主题', remote: '远程',
      skill: '技能', fun: '娱乐', security: '安全', browser: '浏览器', git: 'Git',
      vision: '视觉', docs: '文档', market: '市场', voice: '语音', identity: '身份',
      agi: 'AGI', wsl: 'WSL', uncategorized: '未分类',
    },
  },
}

/**
 * Build the page.
 * @param {object} matrix - output of createMatrix()
 * @param {{title?: string, indexUrl?: string, toolVersion?: string,
 *          catalog?: Map<string, {category?: string, added?: string}>}} [meta]
 * @returns {string} complete HTML document
 */
/** Absolute URL of this page, for canonical and link previews. */
const COMPAT_URL = 'https://easonmws.github.io/dsh-plugin-health/compat/'

export function renderCompatPage(matrix, meta = {}) {
  const hosts = matrix.hosts ?? []
  const catalog = meta.catalog instanceof Map ? meta.catalog : new Map()
  const plugins = [...(matrix.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const generated = matrix.generatedAt ?? new Date().toISOString()
  const en = STRINGS.en

  const rawCategories = new Set()
  const rows = plugins.map((plugin) => {
    const entry = catalog.get(plugin.name) ?? {}
    const category = typeof entry.category === 'string' && entry.category !== '' ? entry.category : 'uncategorized'
    rawCategories.add(category)

    const cells = hosts.map((host) => {
      const state = cellState(plugin.results?.[host])
      return `<td class="c ${state.cls}" title="${esc(state.label)}"><span aria-hidden="true">${state.glyph}</span><span class="sr">${esc(state.label)}</span></td>`
    }).join('')

    const incompatible = plugin.summary?.incompatible ?? 0
    const requirements = Object.entries(plugin.results ?? {})
      .flatMap(([host, result]) => Object.entries(result?.requirements ?? {}).map(([k, v]) => `${host}: ${k} ${v}`))
    const released = dayOf(plugin.publishedAt)

    return `<tr data-name="${esc(plugin.name.toLowerCase())}" data-bad="${incompatible > 0 ? '1' : '0'}" data-cat="${esc(category)}" data-released="${esc(released)}">
      <th scope="row"><span class="name">${esc(plugin.name)}</span><span class="ver">${esc(plugin.version ?? '')}</span></th>
      <td class="cat"><span class="pill" data-cat-label="${esc(category)}">${esc(en.categories[category] ?? category)}</span></td>
      <td class="date">${released === '' ? '<span class="dim">—</span>' : esc(released)}</td>
      ${cells}
      <td class="notes">${incompatible > 0
        ? `<span class="badge"><span data-i18n="rejectedBy">${en.rejectedBy}</span> ${incompatible}</span>`
        : ''}${
        requirements.length > 0 && incompatible > 0
          ? `<details><summary data-i18n="declared">${en.declared}</summary><pre>${esc(requirements.slice(0, 6).join('\n'))}</pre></details>`
          : ''}</td>
    </tr>`
  }).join('\n')

  // The role under each version is what stops a reader treating an outdated prerelease column as
  // "another current host". It is absent for matrices that were not built from a selection.
  const roles = matrix.hostRoles ?? {}
  const roleLabel = (role) => (role === 'latest' ? en.roleLatest : role === 'previous' ? en.rolePrevious : en.rolePreview)
  const headerCells = hosts.map((host) => {
    const role = roles[host]
    const label = role === undefined ? '' : `<span class="role">${esc(roleLabel(role))}</span>`
    return `<th scope="col" class="c">${esc(host)}${label}</th>`
  }).join('')
  const hostSummary = hosts.map((host) => ({
    host,
    ok: plugins.filter((plugin) => plugin.results?.[host]?.compatible === true).length,
    bad: plugins.filter((plugin) => plugin.results?.[host]?.compatible === false).length,
    total: plugins.length,
  }))
  const summaryLines = hostSummary.map((row) =>
    `<li><strong>${esc(row.host)}</strong> — <span data-i18n="hostLine" data-n="${row.bad}" data-total="${row.total}" data-ok="${row.ok}">${row.bad} ${en.hostLine} (${row.ok} ${en.accepted})</span></li>`).join('')

  const sortedCategories = [...rawCategories].sort()
  const categoryOptions = sortedCategories.map((category) =>
    `<option value="${esc(category)}" data-cat-label="${esc(category)}">${esc(en.categories[category] ?? category)}</option>`).join('')

  // Top-line counts. "Healthy" has to mean all hosts accept it, not the newest one — a plugin that
  // loads on rc.5 but not on `next` is not healthy, it is a warning.
  const total = plugins.length
  const healthy = plugins.filter((plugin) => (plugin.summary?.incompatible ?? 0) === 0
    && (plugin.summary?.errors ?? 0) === 0).length
  const rejected = plugins.filter((plugin) => (plugin.summary?.incompatible ?? 0) > 0).length
  // The headline is rejection on the host a current user runs. "Rejected by at least one" stays visible but
  // secondary: it is true, it is just not the question the reader came with.
  const latestHost = hosts.find((host) => matrix.hostRoles?.[host] === 'latest') ?? hosts[0]
  const rejectedOnLatest = latestHost === undefined
    ? 0
    : plugins.filter((plugin) => plugin.results?.[latestHost]?.compatible === false).length
  const acceptedOnLatest = total - rejectedOnLatest
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100))

  const title = meta.title ?? en.heading
  const stampDate = generated.slice(0, 16).replace('T', ' ')
  const sourceText = en.source.replace('{n}', String(total))
  const dropped = Array.isArray(matrix.hostsDropped) ? matrix.hostsDropped : []
  const droppedList = dropped
    .map((row) => `${row.spec}${row.version === null || row.version === undefined ? '' : ` (${row.version})`}`)
    .join(', ')
  const droppedText = dropped.length === 0 ? '' : `${en.ignoredTags}${droppedList}`

  // Serialised into the page so the toggle has both dictionaries without a second request. `</` is
  // escaped so a string can never close the script element early.
  const dictJson = JSON.stringify({ en: STRINGS.en, zh: STRINGS.zh, defaultLang: 'en' })
    .replace(/<\//g, '<\\/')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(en.description)} ${esc(String(total))} plugins, ${hosts.length} host versions, updated daily.">
<link rel="canonical" href="${COMPAT_URL}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="dsh-plugin-health">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(en.description)} ${esc(String(total))} plugins checked across ${hosts.length} host versions.">
<meta property="og:url" content="${COMPAT_URL}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(en.description)} ${esc(String(total))} plugins checked across ${hosts.length} host versions.">
<style>
  :root { color-scheme: light dark; --ok:#137333; --bad:#c5221f; --unk:#8a6d00; --line:#8883; --pill:#8881; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif; padding:0 20px 60px; }
  main { max-width: 940px; margin: 0 auto; }
  .topbar { display:flex; justify-content:flex-end; gap:6px; padding-top:18px; }
  .lang { display:inline-flex; border:1px solid var(--line); border-radius: 7px; overflow:hidden; }
  .lang button { padding: 5px 11px; font: inherit; font-size: 12.5px; border: 0; background: transparent; color: inherit; cursor: pointer; opacity: .6; }
  .lang button[aria-pressed=true] { background: CanvasText; color: Canvas; opacity: 1; }
  h1 { font-size: 1.5rem; margin: 14px 0 8px; letter-spacing: -.01em; }
  .lede { margin: 0 0 10px; opacity: .78; }
  .stamp { font-size: 12.5px; opacity: .55; margin: 0 0 18px; }

  .tally { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 20px; }
  .tally .cell { flex: 1 1 150px; border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
  .tally .n { font-size: 1.65rem; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .tally .k { font-size: 12px; opacity: .6; }
  .tally .ok .n { color: var(--ok); }
.tally .any .n, .tally .all .n { font-size: 1.15rem; opacity: .55; }
.tally .any .k, .tally .all .k { opacity: .45; }
th .role { display: block; font-size: 10.5px; font-weight: 400; opacity: .55; letter-spacing: .02em; }
.ignored { font-size: 12.5px; opacity: .6; margin: 0 0 10px; }
  .tally .bad .n { color: var(--bad); }

  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin: 0 0 2px; padding: 12px 0 10px; position: sticky; top: 0; background: Canvas; z-index: 2; }
  input[type=search], select { padding: 7px 10px; font: inherit; font-size: 13.5px; border: 1px solid var(--line); border-radius: 7px; background: Field; color: FieldText; }
  input[type=search] { flex: 1 1 200px; min-width: 150px; }
  input[type=search]:focus, select:focus { outline: 2px solid color-mix(in srgb, CanvasText 35%, transparent); outline-offset: 1px; }
  .chip { padding: 7px 13px; font: inherit; font-size: 13.5px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
  .chip[aria-pressed=true] { background: CanvasText; color: Canvas; border-color: CanvasText; }
  #count { font-size: 12.5px; opacity: .55; }

  table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 14px; }
  thead th { padding: 8px 6px; font-size: 11px; font-weight: 600; text-align: left; opacity: .6; border-bottom: 1px solid var(--line); white-space: nowrap; text-transform: uppercase; letter-spacing: .04em; cursor: pointer; user-select: none; }
  thead th.c, thead th.notes { cursor: default; }
  thead th:first-child { width: auto; }
  thead th.cat { width: 132px; }
  thead th.date { width: 104px; }
  thead th.c { width: 92px; text-align: center; text-transform: none; letter-spacing: 0; font-size: 11px; }
  thead th.notes { width: 170px; }
  tbody th { text-align: left; padding: 9px 6px; font-weight: 400; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  tbody td { padding: 9px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .name { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 13px; }
  .ver { opacity: .42; font-size: 11.5px; margin-left: 6px; }
  .pill { display:inline-block; padding: 1px 8px; border-radius: 999px; background: var(--pill); font-size: 11.5px; opacity: .85; white-space: nowrap; }
  .date { font-size: 12.5px; opacity: .72; font-variant-numeric: tabular-nums; }
  .dim { opacity: .4; }
  td.c { text-align: center; font-size: 15px; font-weight: 600; }
  td.c.ok { color: var(--ok); }
  td.c.bad { color: var(--bad); }
  td.c.unknown { color: var(--unk); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  .badge { display:inline-block; font-size: 11.5px; line-height: 1.35; color: var(--bad); }
  .notes details { margin-top: 3px; }
  .notes summary { font-size: 11.5px; opacity: .55; cursor: pointer; }
  .notes pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; opacity: .7; }

  .summary { margin: 26px 0 0; font-size: 13.5px; }
  /* Scoped to the section label: the per-host <strong> inside each list item must stay inline and
     keep its real casing, or the version reads as "0.2.1-RC.5" on its own line. */
  .summary .label { display:block; margin-bottom: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .summary ul { margin: 0; padding-left: 18px; opacity: .8; }
  .caveat { margin: 26px 0 0; font-size: 13px; opacity: .72; border-left: 2px solid var(--line); padding-left: 14px; }
  footer { margin-top: 28px; font-size: 12.5px; opacity: .62; }
  footer p { margin: 0 0 9px; }
  .src { max-width: 72ch; line-height: 1.6; }
  a { color: inherit; }
  .empty { padding: 30px 6px; opacity: .6; font-size: 14px; }
  @media (max-width: 760px) {
    thead th.notes, td.notes { display: none; }
    thead th.cat, td.cat { display: none; }
    thead th.c { width: 64px; }
    thead th.date { width: 88px; }
  }
</style>
</head>
<body>
<main>
  <div class="topbar">
    <span class="lang" role="group" aria-label="${esc(en.langLabel)}">
      <button type="button" data-lang="en" aria-pressed="true">EN</button><button type="button" data-lang="zh" aria-pressed="false">中文</button>
    </span>
  </div>

  <h1 data-i18n="heading">${esc(en.heading)}</h1>
  <p class="lede" data-i18n="lede">${esc(en.lede)}</p>
  ${droppedText === '' ? '' : `<p class="ignored" data-i18n="ignoredTags" data-list="${esc(droppedList)}">${esc(droppedText)}</p>`}
  <p class="stamp"><span data-i18n="updated">${en.updated}</span> ${esc(stampDate)} UTC ·
    <span data-i18n="tallyStamp" data-total="${total}" data-hosts="${hosts.length}">${total} ${en.pluginsWord} × ${hosts.length} host versions</span></p>

  <div class="tally">
    <div class="cell"><span class="n">${total}</span><span class="k" data-i18n="checked">${esc(en.checked)}</span></div>
    <div class="cell ok"><span class="n">${acceptedOnLatest}</span><span class="k" data-i18n="acceptedOnLatest" data-pct="${pct(acceptedOnLatest)}" data-host="${esc(latestHost ?? '')}">${esc(en.acceptedOnLatest)} — ${esc(latestHost ?? '')} (${pct(acceptedOnLatest)}%)</span></div>
    <div class="cell bad"><span class="n">${rejectedOnLatest}</span><span class="k" data-i18n="rejectedOnLatest" data-pct="${pct(rejectedOnLatest)}" data-host="${esc(latestHost ?? '')}">${esc(en.rejectedOnLatest)} — ${esc(latestHost ?? '')} (${pct(rejectedOnLatest)}%)</span></div>
    <div class="cell all"><span class="n">${healthy}</span><span class="k" data-i18n="healthy" data-pct="${pct(healthy)}">${esc(en.healthy)} (${pct(healthy)}%)</span></div>
    <div class="cell any"><span class="n">${rejected}</span><span class="k" data-i18n="rejected" data-pct="${pct(rejected)}">${esc(en.rejected)} (${pct(rejected)}%)</span></div>
  </div>

  <div class="controls">
    <input type="search" id="q" placeholder="${esc(en.filterName)}" data-i18n-placeholder="filterName" aria-label="${esc(en.filterName)}">
    <select id="cat" aria-label="${esc(en.allCategories)}">
      <option value="" data-i18n="allCategories">${esc(en.allCategories)}</option>
      ${categoryOptions}
    </select>
    <button class="chip" id="onlyBad" aria-pressed="false" data-i18n="onlyRejected">${esc(en.onlyRejected)}</button>
    <span id="count"></span>
  </div>

  <table>
    <thead><tr>
      <th scope="col" data-sort="name" data-i18n="colPlugin">${esc(en.colPlugin)}</th>
      <th scope="col" class="cat" data-i18n="colCategory">${esc(en.colCategory)}</th>
      <th scope="col" class="date" data-sort="released" data-i18n="colReleased">${esc(en.colReleased)}</th>
      ${headerCells}
      <th scope="col" class="notes" data-i18n="colNotes">${esc(en.colNotes)}</th>
    </tr></thead>
    <tbody id="rows">
${rows}
    </tbody>
  </table>
  <p class="empty" id="empty" hidden data-i18n="empty">${esc(en.empty)}</p>

  <div class="summary">
    <strong class="label" data-i18n="byHost">${esc(en.byHost)}</strong>
    <ul>${summaryLines}</ul>
  </div>

  <p class="caveat"><strong data-i18n="caveatHead">${esc(en.caveatHead)}</strong> <span data-i18n="caveat">${esc(en.caveat)}</span></p>

  <footer>
    <p class="src"><strong data-i18n="sourceHead">${esc(en.sourceHead)}</strong> <span data-i18n="source" data-n="${total}">${esc(sourceText)}</span></p>
    <p><span data-i18n="generatedBy">${esc(en.generatedBy)}</span> <a href="https://github.com/EasonMWS/dsh-plugin-health">dsh-plugin-health</a>${
      meta.toolVersion ? ` ${esc(meta.toolVersion)}` : ''}${
      meta.indexUrl ? ` · <a href="${esc(meta.indexUrl)}" data-i18n="pluginIndex">${esc(en.pluginIndex)}</a>` : ''} ·
    <a href="https://github.com/EasonMWS/dsh-plugin-health/issues" data-i18n="reportRow">${esc(en.reportRow)}</a></p>
  </footer>
</main>
<script type="application/json" id="i18n">${dictJson}</script>
<script>
(function () {
  var dict = JSON.parse(document.getElementById('i18n').textContent);
  var q = document.getElementById('q');
  var cat = document.getElementById('cat');
  var onlyBad = document.getElementById('onlyBad');
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var tbody = document.getElementById('rows');
  var rows = Array.prototype.slice.call(tbody.rows);
  var bad = false;
  var lang = dict.defaultLang;

  function t(key) {
    var table = dict[lang] || dict.en;
    return table[key] !== undefined ? table[key] : (dict.en[key] !== undefined ? dict.en[key] : key);
  }

  function applyLanguage(next) {
    lang = next;
    var table = dict[lang] || dict.en;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('title');
    var meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', t('description'));

    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      var key = el.getAttribute('data-i18n');
      var text = t(key);
      if (key === 'tallyStamp') {
        var hosts = el.getAttribute('data-hosts');
        text = lang === 'zh'
          ? el.getAttribute('data-total') + ' ' + text + ' × ' + hosts + ' 个宿主版本'
          : el.getAttribute('data-total') + ' ' + text + ' × ' + hosts + ' host versions';
      } else if (key === 'healthy' || key === 'rejected') {
        text = text + ' (' + el.getAttribute('data-pct') + '%)';
      } else if (key === 'acceptedOnLatest' || key === 'rejectedOnLatest') {
        text = text + ' — ' + el.getAttribute('data-host') + ' (' + el.getAttribute('data-pct') + '%)';
      } else if (key === 'ignoredTags') {
        text = text + el.getAttribute('data-list');
      } else if (key === 'hostLine') {
        text = el.getAttribute('data-n') + ' ' + text + ' (' + el.getAttribute('data-ok') + ' ' + t('accepted') + ')';
      } else if (key === 'source') {
        text = text.replace('{n}', el.getAttribute('data-n'));
      }
      el.textContent = text;
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-placeholder]'), function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });

    // Category labels live on both the row pills and the dropdown options.
    var cats = table.categories || {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-cat-label]'), function (el) {
      var key = el.getAttribute('data-cat-label');
      el.textContent = cats[key] !== undefined ? cats[key] : key;
    });

    Array.prototype.forEach.call(document.querySelectorAll('.lang button'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-lang') === lang ? 'true' : 'false');
    });

    try { localStorage.setItem('dsh-compat-lang', lang); } catch (e) {}
    apply();
  }

  function apply() {
    var needle = q.value.trim().toLowerCase();
    var wantCat = cat.value;
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hit = !needle || row.getAttribute('data-name').indexOf(needle) !== -1;
      if (hit && wantCat && row.getAttribute('data-cat') !== wantCat) hit = false;
      if (hit && bad && row.getAttribute('data-bad') !== '1') hit = false;
      row.hidden = !hit;
      if (hit) shown++;
    }
    count.textContent = shown === rows.length
      ? shown + ' ' + t('pluginsWord')
      : shown + ' ' + t('shownOf') + ' ' + rows.length;
    empty.hidden = shown !== 0;
  }

  q.addEventListener('input', apply);
  cat.addEventListener('change', apply);
  onlyBad.addEventListener('click', function () {
    bad = !bad;
    onlyBad.setAttribute('aria-pressed', bad ? 'true' : 'false');
    apply();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.lang button'), function (button) {
    button.addEventListener('click', function () { applyLanguage(button.getAttribute('data-lang')); });
  });

  // Sorting is only offered where the order is unambiguous. Rows are re-ordered in place; the
  // per-host columns are not sortable because "how many hosts reject this" is what people mean.
  var sortState = {};
  Array.prototype.forEach.call(document.querySelectorAll('thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      var dir = sortState[key] === 'asc' ? 'desc' : 'asc';
      sortState[key] = dir;
      rows.sort(function (a, b) {
        var av, bv;
        if (key === 'name') {
          av = a.getAttribute('data-name');
          bv = b.getAttribute('data-name');
        } else {
          av = a.getAttribute('data-released') || '0000-00-00';
          bv = b.getAttribute('data-released') || '0000-00-00';
        }
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (dir === 'asc' ? 1 : -1);
      });
      rows.forEach(function (row) { tbody.appendChild(row); });
    });
  });

  // Start in the stored language, else the browser's, else English.
  var stored = null;
  try { stored = localStorage.getItem('dsh-compat-lang'); } catch (e) {}
  var initial = stored === 'zh' || stored === 'en'
    ? stored
    : ((navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en');
  applyLanguage(initial);
})();
</script>
</body>
</html>
`
}