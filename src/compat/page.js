/**
 * Render a compatibility matrix as a standalone HTML page.
 *
 * One row per plugin, one column per host version, plus what the table can add beyond a tick: whether the
 * plugin actually boots on the latest host (when a verify run exists), what the next host build will do to it,
 * a suggested fix when it is rejected, since when its state has held, and predicted conflicts.
 *
 * **Size.** The catalogue is ~5,000 plugins. Rendering all of them as DOM made a 3 MB page with ~72,000 nodes
 * and a 0.7 s filter. The HTML now carries the first rows for crawlers and no-JS readers; the rest is
 * `rows.json`, filtered and sorted as an array and rendered 100 rows at a time.
 *
 * **Trust.** Names, versions, failure details and tool names come from third-party packages and from runs of
 * their code. On the server they go through `esc`; in the browser they are only assigned with `textContent`.
 * No markup is ever built from them.
 *
 * **Language.** English is in the markup so the first paint and a crawler get real text; a second dictionary
 * swaps it in place. Rows are re-rendered from data on a language change, so no row text is baked in twice.
 *
 * The page states what it does *not* know: a tick means the installer accepts the plugin, "boots" means its
 * entries activated, and neither is a review of what the code does.
 */
import { buildRows, COMPAT_URL, latestHostOf } from './rows.js'

/** How many rows the HTML carries before the full data loads. */
export const INLINE_ROWS = 100

/** Escape text for HTML text nodes and attribute values. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FAILURE_KINDS = [
  'gate-rejected', 'not-found', 'build-scripts-blocked', 'peer-conflict', 'network', 'install-timeout',
  'host-contract-changed', 'boot-import-error', 'missing-service', 'not-mounted', 'not-activated',
  'tool-missing', 'call-failed', 'shutdown-hang', 'orphan-process', 'unknown',
]

/**
 * Every user-visible string, both languages. Failure kinds are flattened to `k_<kind>` keys so the
 * dictionary stays flat and every entry can be checked for translation.
 */
const STRINGS = {
  en: {
    heading: 'DSH plugin compatibility',
    lede: 'Check version declarations for entries in the community catalog. Startup results appear for entries with a separate boot test.',
    updated: 'Updated',
    checked: 'compatibility table entries',
    healthy: 'entries with no recorded rejection or error',
    rejected: 'entries rejected by at least one host',
    rejectedOnLatest: 'entries rejected on the latest host',
    acceptedOnLatest: 'entries with no recorded rejection on the latest host',
    atRiskTally: 'entries at risk on the next build',
    roleLatest: 'latest',
    rolePrevious: 'previous line',
    rolePreview: 'preview',
    ignoredTags: 'Older prerelease tags are left out: ',
    filterName: 'Filter by plugin name…',
    allCategories: 'All categories',
    onlyRejected: 'Only rejected',
    statusAll: 'All plugins',
    statusRejected: 'Rejected on the latest host',
    statusAtRisk: 'Next build will reject',
    statusStale: 'Rejected, but boots when exempted',
    statusUndeclared: 'No declaration',
    statusVerified: 'Boot-tested: starts',
    githubOnly: 'GitHub only: judged from the default branch, not a published package',
    colPlugin: 'Plugin',
    colCategory: 'Category',
    colReleased: 'Released',
    colNotes: 'Notes',
    rejectedBy: 'rejected by',
    declared: 'declared',
    stateOk: 'declared compatible',
    stateNone: 'no declaration: the host does not check it',
    stateBad: 'rejected',
    stateErr: 'unknown',
    stateNa: 'not tested',
    levelV3: 'boots',
    levelV2: 'installs, does not start',
    levelV1: 'does not install',
    bypassBoots: 'boots when exempted',
    bypassFails: 'fails even when exempted',
    evidence: 'evidence',
    suggested: 'Suggested range',
    suggestionNote: 'a suggestion; the author decides',
    allPeers: 'on {n} DSH peers',
    crossesLine: 'declared for an older host line: check it boots there first',
    caretZero: 'on 0.x, ^ only admits the same minor',
    rangeExcludes: 'the declared range ends before this host',
    forecast: 'Next build rejects it:',
    rejectedSince: 'rejected since',
    acceptedSince: 'accepted since',
    fixedOn: 'fixed on',
    conflictWith: 'may conflict with',
    conflictTool: 'same tool name',
    conflictEntry: 'same entry id',
    predicted: 'predicted',
    copyLink: 'copy link',
    copied: 'copied',
    showMore: 'Show more entries',
    partial: 'The first rows are shown here; the full list loads with JavaScript.',
    byHost: 'By host version',
    hostLine: 'Rejected',
    accepted: 'Accepted',
    empty: 'No plugin matches those filters.',
    legendHead: 'What the marks mean.',
    legendDeclared: '✓ the declared range admits that host, so the installer accepts it. ○ no declaration at all: the host does not check it, which is not the same as passing. ✕ rejected.',
    legendLevels: 'Boot-tested on the latest host, in a clean throwaway profile: "boots" means every entry of the plugin activated; "installs, does not start" and "does not install" give the reason. A rejected plugin is also tried once with an exemption, to tell a stale declaration from broken code; that never turns the row green.',
    legendForecast: '"Next build rejects it" reads the plugin\'s own declaration against the next prerelease and the release of the current host line. It is a forecast: those builds may never ship under those numbers.',
    legendNotCovered: 'Not covered: whether the features work, anything that needs an API key, and the desktop app. None of this is a security review. Conflicts are predicted from what each plugin registers on its own; the plugins were not installed together.',
    caveatHead: 'Read this before relying on a row.',
    caveat: 'A tick means the plugin\'s declared ranges admit that host, so the installer will not reject it. It does not mean the plugin works, and it is not a security review. "Released" is the publish date of the version shown, which tells you whether the maintainer has been active on the current host line. A plugin that is missing was never checked. When a plugin is marked rejected the cause is usually a one-line range update in its package.json, which the maintainer has to ship — you cannot fix it locally.',
    sourceHead: 'Where this comes from.',
    source: 'Entries come from awesome-dsh-plugin. Your installation scan count appears in Plugin health settings. The table uses published npm manifests and default-branch manifests for entries marked "GitHub only". It omits GitHub repositories whose manifest could not be read. The table entry count includes rows with unknown results. Declaration checks read manifests only. Startup results have separate evidence links. Rebuilt daily.',
    generatedBy: 'Generated by',
    pluginIndex: 'plugin index',
    reportRow: 'report a wrong row',
    langLabel: 'Language',
    title: 'DSH plugin compatibility — version declarations and startup tests',
    description: 'Version declarations and startup tests for DSH community catalog entries.',
    shownOf: 'Matching entries: {matched} of {loaded} loaded',
    'k_gate-rejected': 'rejected by its declaration',
    'k_not-found': 'version not found',
    'k_build-scripts-blocked': 'build scripts blocked',
    'k_peer-conflict': 'peer dependency conflict',
    k_network: 'network problem during the test',
    'k_install-timeout': 'install timed out',
    'k_host-contract-changed': 'the host changed under the test',
    'k_boot-import-error': 'a module failed to import',
    'k_missing-service': 'waits for a service the profile lacks',
    'k_not-mounted': 'never mounted',
    'k_not-activated': 'did not activate',
    'k_tool-missing': 'a tool did not register',
    'k_call-failed': 'a tool call failed',
    'k_shutdown-hang': 'hung on shutdown',
    'k_orphan-process': 'left a process behind',
    k_unknown: 'unclassified failure',
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
    lede: '查询社区目录条目的版本声明。单独做过启动实测的条目会显示实测结果。',
    updated: '更新于',
    checked: '兼容表收录条目',
    healthy: '无拒绝或报错记录的条目',
    rejected: '至少被一个宿主拒绝的条目',
    rejectedOnLatest: '最新版拒绝的条目',
    acceptedOnLatest: '最新版无拒绝记录的条目',
    atRiskTally: '预计下个版本会拒绝的条目',
    roleLatest: '最新',
    rolePrevious: '上一版本线',
    rolePreview: '预览',
    ignoredTags: '已忽略更旧的预发布 tag：',
    filterName: '按插件名筛选…',
    allCategories: '全部分类',
    onlyRejected: '只看被拒的',
    statusAll: '全部插件',
    statusRejected: '在最新版上被拒',
    statusAtRisk: '下个版本会被拒',
    statusStale: '被拒，但放行后能启动',
    statusUndeclared: '没有声明',
    statusVerified: '实测能启动',
    githubOnly: '仅 GitHub：按默认分支判定，不是已发布的包',
    colPlugin: '插件',
    colCategory: '分类',
    colReleased: '发布日期',
    colNotes: '说明',
    rejectedBy: '被拒',
    declared: '声明',
    stateOk: '声明兼容',
    stateNone: '未声明：宿主不检查',
    stateBad: '被拒',
    stateErr: '未知',
    stateNa: '未检查',
    levelV3: '能启动',
    levelV2: '能装上，起不来',
    levelV1: '装不上',
    bypassBoots: '放行后能启动',
    bypassFails: '放行后也起不来',
    evidence: '证据',
    suggested: '建议范围',
    suggestionNote: '仅为建议，由作者决定',
    allPeers: '用于 {n} 个 DSH peer',
    crossesLine: '原本为旧版本线声明：先确认能在新线上启动',
    caretZero: '0.x 上的 ^ 只允许同一个 minor',
    rangeExcludes: '声明的范围在这个宿主之前就结束了',
    forecast: '下个版本会拒绝它：',
    rejectedSince: '被拒始于',
    acceptedSince: '接受始于',
    fixedOn: '修复于',
    conflictWith: '可能冲突：',
    conflictTool: '工具重名',
    conflictEntry: '条目 id 重复',
    predicted: '预测',
    copyLink: '复制链接',
    copied: '已复制',
    showMore: '显示更多条目',
    partial: '这里只显示前面一部分；完整列表需要 JavaScript 加载。',
    byHost: '按宿主版本',
    hostLine: '拒绝条目',
    accepted: '接受条目',
    empty: '没有插件匹配当前筛选条件。',
    legendHead: '标记是什么意思。',
    legendDeclared: '✓ 声明的范围包含这个宿主，安装器会接受它。○ 完全没有声明：宿主不检查它，这不等于通过。✕ 被拒。',
    legendLevels: '在最新宿主上、干净的一次性 profile 里做的启动实测：「能启动」表示插件的每个条目都激活了；「能装上，起不来」和「装不上」会写明原因。被拒的插件还会带豁免再试一次，用来区分「声明过时」和「代码坏了」——这不会让这一行变绿。',
    legendForecast: '「下个版本会拒绝它」是拿插件自己的声明，去对当前版本线的下一个预发布版和正式版。这是预测：那两个版本不一定以这个版本号发布。',
    legendNotCovered: '不覆盖：功能是否正确、需要 API key 的功能、桌面版。这些都不是安全审查。冲突是根据每个插件单独注册了什么来预测的，并没有把它们装在一起跑过。',
    caveatHead: '看这一行之前，请先读这里。',
    caveat: '打勾表示插件的声明范围包含那个宿主版本，安装器不会拒绝它。这不代表插件能用，也不是安全审查。「发布日期」是当前显示版本的发布时间，可以据此判断作者是否还在维护。「没查到」的插件是从来没被检查过，不是通过。被标为拒绝的，原因通常是 package.json 里一行版本范围要改——这得作者发版，你在本地改不了。',
    sourceHead: '数据从哪来。',
    source: '条目来自 awesome-dsh-plugin 社区目录。当前环境的安装扫描包数可在设置中的「插件健康」查看。npm 条目使用已发布的包清单，「仅 GitHub」条目使用默认分支的清单，读不到清单的 GitHub 仓库会略过。兼容表收录条目含结果未知的行。声明检查只读取清单，启动实测有单独的证据链接。每天重建一次。',
    generatedBy: '由',
    pluginIndex: '插件索引',
    reportRow: '报错一行',
    langLabel: '语言',
    title: 'DSH 插件兼容性 — 版本声明与启动实测',
    description: 'DSH 社区目录条目的版本声明与启动实测。',
    shownOf: '匹配条目：{matched} / 已加载条目：{loaded}',
    'k_gate-rejected': '被自己的声明拒绝',
    'k_not-found': '找不到这个版本',
    'k_build-scripts-blocked': '构建脚本被拦',
    'k_peer-conflict': 'peer 依赖冲突',
    k_network: '测试时网络出问题',
    'k_install-timeout': '安装超时',
    'k_host-contract-changed': '宿主接口在测试中变了',
    'k_boot-import-error': '模块导入失败',
    'k_missing-service': '在等一个 profile 里没有的服务',
    'k_not-mounted': '没有挂载',
    'k_not-activated': '没有激活',
    'k_tool-missing': '有工具没注册上',
    'k_call-failed': '工具调用失败',
    'k_shutdown-hang': '关闭时卡住',
    'k_orphan-process': '留下了残留进程',
    k_unknown: '无法归类的失败',
    categories: {
      ui: '界面', tools: '工具', session: '会话', workflow: '工作流', dev: '开发', model: '模型',
      usage: '用量', memory: '记忆', notify: '通知', theme: '主题', remote: '远程',
      skill: '技能', fun: '娱乐', security: '安全', browser: '浏览器', git: 'Git',
      vision: '视觉', docs: '文档', market: '市场', voice: '语音', identity: '身份',
      agi: 'AGI', wsl: 'WSL', uncategorized: '未分类',
    },
  },
}

const STATE = {
  ok: { glyph: '✓', key: 'stateOk', cls: 'ok' },
  none: { glyph: '○', key: 'stateNone', cls: 'none' },
  bad: { glyph: '✕', key: 'stateBad', cls: 'bad' },
  err: { glyph: '?', key: 'stateErr', cls: 'unknown' },
  na: { glyph: '–', key: 'stateNa', cls: 'unknown' },
}

/** Server rendering of one row, English. The browser renders the same structure from the same data. */
function rowHtml(row, latestIndex) {
  const en = STRINGS.en
  const cells = row.s.map((code, index) => {
    const state = STATE[code] ?? STATE.na
    const level = index === latestIndex && row.l
      ? `<span class="lvl lvl-${esc(row.l)}">${esc(en[`level${row.l}`] ?? row.l)}</span>`
      : ''
    return `<td class="c ${state.cls}" title="${esc(en[state.key])}"><span aria-hidden="true">${state.glyph}</span><span class="sr">${esc(en[state.key])}</span>${level}</td>`
  }).join('')
  const notes = []
  if (row.src === 'github') notes.push(`<span class="sub" data-i18n="githubOnly">${esc(en.githubOnly)}</span>`)
  if (row.bad > 0) notes.push(`<span class="badge"><span data-i18n="rejectedBy">${en.rejectedBy}</span> ${row.bad}</span>`)
  if (row.f) notes.push(`<span class="warn">${esc(en.forecast)} ${esc(row.f.join(', '))}</span>`)
  if (row.h) {
    const groups = row.h.g ?? row.h.sug.map(([field, range]) => ({ range, fields: [field] }))
    notes.push(`<span class="hint">${esc(en.suggested)}: ${esc(groups.map((group) => (group.fields.length === 1
      ? `${group.fields[0]} ${group.range}`
      : `${group.range} (${en.allPeers.replace('{n}', String(group.fields.length))})`)).join('; '))}</span>`)
  }
  if (row.q.length > 0) notes.push(`<details><summary data-i18n="declared">${en.declared}</summary><pre>${esc(row.q.join('\n'))}</pre></details>`)
  return `<tr id="p-${esc(row.slug)}" data-name="${esc(row.n.toLowerCase())}" data-bad="${row.bad > 0 ? '1' : '0'}" data-cat="${esc(row.c)}" data-released="${esc(row.r)}">
      <th scope="row"><a class="name" href="#p-${esc(row.slug)}">${esc(row.n)}</a><span class="ver">${esc(row.v)}</span></th>
      <td class="cat"><span class="pill" data-cat-label="${esc(row.c)}">${esc(en.categories[row.c] ?? row.c)}</span></td>
      <td class="date">${row.r === '' ? '<span class="dim">—</span>' : esc(row.r)}</td>
      ${cells}
      <td class="notes">${notes.join('')}</td>
    </tr>`
}

/**
 * Build the page.
 * @param {object} matrix - output of createMatrix()
 * @param {{title?: string, indexUrl?: string, toolVersion?: string, rowsUrl?: string,
 *          catalog?: Map<string, {category?: string}>, verify?: object, conflicts?: Map, history?: Map,
 *          rows?: object[]}} [meta]
 * @returns {string} complete HTML document
 */
export function renderCompatPage(matrix, meta = {}) {
  const hosts = matrix.hosts ?? []
  const rows = meta.rows ?? buildRows(matrix, meta)
  const generated = matrix.generatedAt ?? new Date().toISOString()
  const en = STRINGS.en
  const latestHost = latestHostOf(matrix)
  const latestIndex = latestHost === undefined ? -1 : hosts.indexOf(latestHost)

  const inline = rows.slice(0, INLINE_ROWS)
  const rowMarkup = inline.map((row) => rowHtml(row, latestIndex)).join('\n')

  const roles = matrix.hostRoles ?? {}
  const roleLabel = (role) => (role === 'latest' ? en.roleLatest : role === 'previous' ? en.rolePrevious : en.rolePreview)
  const headerCells = hosts.map((host) => {
    const role = roles[host]
    const label = role === undefined ? '' : `<span class="role">${esc(roleLabel(role))}</span>`
    return `<th scope="col" class="c">${esc(host)}${label}</th>`
  }).join('')

  const plugins = matrix.plugins ?? []
  const hostSummary = hosts.map((host) => ({
    host,
    ok: plugins.filter((plugin) => plugin.results?.[host]?.compatible === true).length,
    bad: plugins.filter((plugin) => plugin.results?.[host]?.compatible === false).length,
  }))
  const summaryLines = hostSummary.map((row) =>
    `<li><strong>${esc(row.host)}</strong> — <span data-i18n="hostLine" data-n="${row.bad}" data-ok="${row.ok}">${en.hostLine}: ${row.bad} · ${en.accepted}: ${row.ok}</span></li>`).join('')

  const sortedCategories = [...new Set(rows.map((row) => row.c))].sort()
  const categoryOptions = sortedCategories.map((category) =>
    `<option value="${esc(category)}" data-cat-label="${esc(category)}">${esc(en.categories[category] ?? category)}</option>`).join('')

  // Unknown and missing results are covered by the tally wording.
  const total = rows.length
  const healthy = rows.filter((row) => row.bad === 0 && row.err === 0).length
  const rejected = rows.filter((row) => row.bad > 0).length
  const rejectedOnLatest = latestIndex < 0 ? 0 : rows.filter((row) => row.s[latestIndex] === 'bad').length
  const acceptedOnLatest = total - rejectedOnLatest
  const atRisk = rows.filter((row) => row.f).length
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100))

  const title = meta.title ?? en.heading
  const stampDate = generated.slice(0, 16).replace('T', ' ')
  const dropped = Array.isArray(matrix.hostsDropped) ? matrix.hostsDropped : []
  const droppedList = dropped
    .map((row) => `${row.spec}${row.version === null || row.version === undefined ? '' : ` (${row.version})`}`)
    .join(', ')
  const droppedText = dropped.length === 0 ? '' : `${en.ignoredTags}${droppedList}`
  const statusOptions = ['statusAll', 'statusRejected', 'statusAtRisk', 'statusStale', 'statusUndeclared', 'statusVerified']
    .map((key, index) => `<option value="${index === 0 ? '' : esc(key)}" data-i18n="${key}">${esc(en[key])}</option>`).join('')

  // Dictionary, inline rows and settings, in the one JSON block. Every `<` becomes `<`: the rows carry
  // third-party names, and no character of them may reach the HTML parser as markup — not `</script>`, not
  // `<!--`, not a tag that only looks harmless because it sits inside a JSON script.
  const payload = JSON.stringify({
    en: STRINGS.en, zh: STRINGS.zh, defaultLang: 'en',
    data: { hosts, latestIndex, rows: inline, total, rowsUrl: meta.rowsUrl ?? (total > inline.length ? 'rows.json' : null), page: COMPAT_URL },
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(en.description)}">
<link rel="canonical" href="${COMPAT_URL}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="dsh-plugin-health">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(en.description)}">
<meta property="og:url" content="${COMPAT_URL}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(en.description)}">
<style>
  :root { color-scheme: light dark; --ok:#137333; --bad:#c5221f; --unk:#8a6d00; --warn:#9a5b00; --line:#8883; --pill:#8881; --hl:#f9c74f40; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif; padding:0 16px 60px; background: Canvas; color: CanvasText; }
  main { max-width: 980px; margin: 0 auto; }
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
  .tally .bad .n { color: var(--bad); }
  .tally .risk .n { color: var(--warn); }
  .tally .any .n, .tally .all .n { font-size: 1.15rem; opacity: .55; }
  .tally .any .k, .tally .all .k { opacity: .45; }
  th .role { display: block; font-size: 10.5px; font-weight: 400; opacity: .55; letter-spacing: .02em; }
  .ignored { font-size: 12.5px; opacity: .6; margin: 0 0 10px; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin: 0 0 2px; padding: 12px 0 10px; position: sticky; top: 0; background: Canvas; z-index: 2; }
  input[type=search], select { padding: 7px 10px; font: inherit; font-size: 13.5px; border: 1px solid var(--line); border-radius: 7px; background: Field; color: FieldText; max-width: 100%; }
  input[type=search] { flex: 1 1 200px; min-width: 150px; }
  input[type=search]:focus, select:focus, button:focus-visible, a:focus-visible { outline: 2px solid color-mix(in srgb, CanvasText 35%, transparent); outline-offset: 1px; }
  .chip { padding: 7px 13px; font: inherit; font-size: 13.5px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
  #count { font-size: 12.5px; opacity: .55; }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 14px; }
  thead th { padding: 8px 6px; font-size: 11px; font-weight: 600; text-align: left; opacity: .6; border-bottom: 1px solid var(--line); white-space: nowrap; text-transform: uppercase; letter-spacing: .04em; cursor: pointer; user-select: none; }
  thead th.c, thead th.notes { cursor: default; }
  thead th.cat { width: 120px; }
  thead th.date { width: 100px; }
  thead th.c { width: 96px; text-align: center; text-transform: none; letter-spacing: 0; font-size: 11px; }
  thead th.notes { width: 230px; }
  tbody th { text-align: left; padding: 9px 6px; font-weight: 400; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; vertical-align: top; }
  tbody td { padding: 9px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:target, tbody tr.hl { background: var(--hl); }
  .name { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 13px; text-decoration: none; }
  .name:hover { text-decoration: underline; }
  .ver { opacity: .42; font-size: 11.5px; margin-left: 6px; }
  .copy { margin-left: 6px; font: inherit; font-size: 11px; padding: 0 5px; border: 1px solid var(--line); border-radius: 5px; background: transparent; color: inherit; cursor: pointer; opacity: .55; }
  .pill { display:inline-block; padding: 1px 8px; border-radius: 999px; background: var(--pill); font-size: 11.5px; opacity: .85; white-space: nowrap; }
  .date { font-size: 12.5px; opacity: .72; font-variant-numeric: tabular-nums; }
  .dim { opacity: .4; }
  td.c { text-align: center; font-size: 15px; font-weight: 600; }
  td.c.ok { color: var(--ok); }
  td.c.bad { color: var(--bad); }
  td.c.none, td.c.unknown { color: var(--unk); }
  .lvl { display: block; font-size: 10.5px; font-weight: 500; margin-top: 2px; }
  .lvl-V3 { color: var(--ok); }
  .lvl-V2, .lvl-V1 { color: var(--bad); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  .notes > span, .notes > a { display: block; font-size: 11.5px; line-height: 1.4; margin-bottom: 3px; }
  .badge { color: var(--bad); }
  .warn { color: var(--warn); }
  .hint code { font-size: 11px; }
  .notes .sub { opacity: .62; }
  .notes details { margin-top: 3px; }
  .notes summary { font-size: 11.5px; opacity: .55; cursor: pointer; }
  .notes pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; opacity: .7; }
  .more { margin: 14px 0 0; }
  .summary { margin: 26px 0 0; font-size: 13.5px; }
  .summary .label { display:block; margin-bottom: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .summary ul { margin: 0; padding-left: 18px; opacity: .8; }
  .legend, .caveat { margin: 26px 0 0; font-size: 13px; opacity: .78; border-left: 2px solid var(--line); padding-left: 14px; }
  .legend p { margin: 0 0 8px; }
  footer { margin-top: 28px; font-size: 12.5px; opacity: .62; }
  footer p { margin: 0 0 9px; }
  .src { max-width: 72ch; line-height: 1.6; }
  a { color: inherit; }
  .empty { padding: 30px 6px; opacity: .6; font-size: 14px; }
  @media (max-width: 760px) {
    thead th.notes, td.notes { display: none; }
    thead th.cat, td.cat { display: none; }
    thead th.c { width: 64px; }
    thead th.date { width: 84px; }
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
  <p class="stamp"><span data-i18n="updated">${en.updated}</span> ${esc(stampDate)} UTC</p>

  <div class="tally">
    <div class="cell"><span class="n">${total}</span><span class="k" data-i18n="checked">${esc(en.checked)}</span></div>
    <div class="cell"><span class="n">${acceptedOnLatest}</span><span class="k" data-i18n="acceptedOnLatest" data-pct="${pct(acceptedOnLatest)}" data-host="${esc(latestHost ?? '')}">${esc(en.acceptedOnLatest)} — ${esc(latestHost ?? '')} (${pct(acceptedOnLatest)}%)</span></div>
    <div class="cell bad"><span class="n">${rejectedOnLatest}</span><span class="k" data-i18n="rejectedOnLatest" data-pct="${pct(rejectedOnLatest)}" data-host="${esc(latestHost ?? '')}">${esc(en.rejectedOnLatest)} — ${esc(latestHost ?? '')} (${pct(rejectedOnLatest)}%)</span></div>
    <div class="cell risk"><span class="n">${atRisk}</span><span class="k" data-i18n="atRiskTally" data-pct="${pct(atRisk)}">${esc(en.atRiskTally)} (${pct(atRisk)}%)</span></div>
    <div class="cell all"><span class="n">${healthy}</span><span class="k" data-i18n="healthy" data-pct="${pct(healthy)}">${esc(en.healthy)} (${pct(healthy)}%)</span></div>
    <div class="cell any"><span class="n">${rejected}</span><span class="k" data-i18n="rejected" data-pct="${pct(rejected)}">${esc(en.rejected)} (${pct(rejected)}%)</span></div>
  </div>

  <div class="controls">
    <input type="search" id="q" placeholder="${esc(en.filterName)}" data-i18n-placeholder="filterName" aria-label="${esc(en.filterName)}">
    <select id="cat" aria-label="${esc(en.allCategories)}">
      <option value="" data-i18n="allCategories">${esc(en.allCategories)}</option>
      ${categoryOptions}
    </select>
    <select id="status" aria-label="${esc(en.statusAll)}">${statusOptions}</select>
    <span id="count"></span>
  </div>

  <div class="tablewrap">
  <table>
    <thead><tr>
      <th scope="col" data-sort="name" data-i18n="colPlugin">${esc(en.colPlugin)}</th>
      <th scope="col" class="cat" data-i18n="colCategory">${esc(en.colCategory)}</th>
      <th scope="col" class="date" data-sort="released" data-i18n="colReleased">${esc(en.colReleased)}</th>
      ${headerCells}
      <th scope="col" class="notes" data-i18n="colNotes">${esc(en.colNotes)}</th>
    </tr></thead>
    <tbody id="rows">
${rowMarkup}
    </tbody>
  </table>
  </div>
  ${total > inline.length ? `<p class="partial" id="partial" data-i18n="partial">${esc(en.partial)}</p>` : ''}
  <p class="empty" id="empty" hidden data-i18n="empty">${esc(en.empty)}</p>
  <p class="more"><button class="chip" id="more" type="button" hidden data-i18n="showMore">${esc(en.showMore)}</button></p>

  <div class="summary">
    <strong class="label" data-i18n="byHost">${esc(en.byHost)}</strong>
    <ul>${summaryLines}</ul>
  </div>

  <div class="legend">
    <p><strong data-i18n="legendHead">${esc(en.legendHead)}</strong> <span data-i18n="legendDeclared">${esc(en.legendDeclared)}</span></p>
    <p data-i18n="legendLevels">${esc(en.legendLevels)}</p>
    <p data-i18n="legendForecast">${esc(en.legendForecast)}</p>
    <p data-i18n="legendNotCovered">${esc(en.legendNotCovered)}</p>
  </div>

  <p class="caveat"><strong data-i18n="caveatHead">${esc(en.caveatHead)}</strong> <span data-i18n="caveat">${esc(en.caveat)}</span></p>

  <footer>
    <p class="src"><strong data-i18n="sourceHead">${esc(en.sourceHead)}</strong> <span data-i18n="source">${esc(en.source)}</span></p>
    <p><span data-i18n="generatedBy">${esc(en.generatedBy)}</span> <a href="https://github.com/EasonMWS/dsh-plugin-health">dsh-plugin-health</a>${
      meta.toolVersion ? ` ${esc(meta.toolVersion)}` : ''}${
      meta.indexUrl ? ` · <a href="${esc(meta.indexUrl)}" data-i18n="pluginIndex">${esc(en.pluginIndex)}</a>` : ''} ·
    <a href="https://github.com/EasonMWS/dsh-plugin-health/issues" data-i18n="reportRow">${esc(en.reportRow)}</a></p>
  </footer>
</main>
<script type="application/json" id="i18n">${payload}</script>
<script>
(function () {
  var dict = JSON.parse(document.getElementById('i18n').textContent);
  var data = dict.data;
  var STATE = { ok: ['\\u2713', 'stateOk', 'ok'], none: ['\\u25cb', 'stateNone', 'none'], bad: ['\\u2715', 'stateBad', 'bad'], err: ['?', 'stateErr', 'unknown'], na: ['\\u2013', 'stateNa', 'unknown'] };
  var PAGE = 100;
  var q = document.getElementById('q');
  var cat = document.getElementById('cat');
  var statusSel = document.getElementById('status');
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var more = document.getElementById('more');
  var tbody = document.getElementById('rows');
  var all = data.rows;
  var filtered = all;
  var shown = 0;
  var sortKey = 'name';
  var sortDir = 1;
  var pinned = null;
  var lang = dict.defaultLang;

  function t(key) {
    var table = dict[lang] || dict.en;
    return table[key] !== undefined ? table[key] : (dict.en[key] !== undefined ? dict.en[key] : key);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function line(parent, cls, text) {
    parent.appendChild(el('span', cls, text));
  }

  // Every value below comes from data and is only ever assigned as text.
  function renderRow(row) {
    var tr = document.createElement('tr');
    tr.id = 'p-' + row.slug;
    tr.setAttribute('data-name', row.n.toLowerCase());
    tr.setAttribute('data-bad', row.bad > 0 ? '1' : '0');
    tr.setAttribute('data-cat', row.c);
    tr.setAttribute('data-released', row.r);
    if (pinned && pinned === row.slug) tr.className = 'hl';

    var th = el('th');
    th.setAttribute('scope', 'row');
    var link = el('a', 'name', row.n);
    link.href = '#p-' + row.slug;
    th.appendChild(link);
    th.appendChild(el('span', 'ver', row.v));
    var copy = el('button', 'copy', t('copyLink'));
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var url = data.page + '#p-' + row.slug;
      var done = function () { copy.textContent = t('copied'); setTimeout(function () { copy.textContent = t('copyLink'); }, 1500); };
      try { navigator.clipboard.writeText(url).then(done, function () { location.hash = 'p-' + row.slug; }); }
      catch (e) { location.hash = 'p-' + row.slug; }
    });
    th.appendChild(copy);
    tr.appendChild(th);

    var catCell = el('td', 'cat');
    var pill = el('span', 'pill', (dict[lang].categories || {})[row.c] || row.c);
    pill.setAttribute('data-cat-label', row.c);
    catCell.appendChild(pill);
    tr.appendChild(catCell);
    tr.appendChild(el('td', 'date', row.r || '\\u2014'));

    for (var i = 0; i < row.s.length; i++) {
      var state = STATE[row.s[i]] || STATE.na;
      var td = el('td', 'c ' + state[2]);
      td.title = t(state[1]);
      var glyph = el('span', null, state[0]);
      glyph.setAttribute('aria-hidden', 'true');
      td.appendChild(glyph);
      td.appendChild(el('span', 'sr', t(state[1])));
      if (i === data.latestIndex && row.l) td.appendChild(el('span', 'lvl lvl-' + row.l, t('level' + row.l)));
      tr.appendChild(td);
    }

    var notes = el('td', 'notes');
    if (row.src === 'github') line(notes, 'sub', t('githubOnly'));
    if (row.bad > 0) line(notes, 'badge', t('rejectedBy') + ' ' + row.bad);
    if (row.k && row.l !== 'V3') line(notes, 'badge', t('k_' + row.k));
    if (row.b) line(notes, row.b === 'V3' ? 'warn' : 'badge', row.b === 'V3' ? t('bypassBoots') : t('bypassFails'));
    if (row.f) line(notes, 'warn', t('forecast') + ' ' + row.f.join(', '));
    if (row.h) {
      var hint = el('span', 'hint');
      hint.appendChild(document.createTextNode(t('suggested') + ': '));
      var groups = row.h.g || row.h.sug.map(function (pair) { return { range: pair[1], fields: [pair[0]] }; });
      for (var h = 0; h < groups.length; h++) {
        var group = groups[h];
        var code = el('code', null, group.fields.length === 1 ? group.fields[0] + ' ' + group.range : group.range);
        if (group.fields.length > 1) code.title = group.fields.join('\\n');
        hint.appendChild(code);
        if (group.fields.length > 1) hint.appendChild(document.createTextNode(' (' + t('allPeers').replace('{n}', group.fields.length) + ')'));
        if (h < groups.length - 1) hint.appendChild(document.createTextNode('; '));
      }
      notes.appendChild(hint);
      line(notes, 'sub', (row.h.reason === 'caret-zero' ? t('caretZero') : t('rangeExcludes')) + ' \\u00b7 ' + t('suggestionNote'));
      if (row.h.crosses) line(notes, 'warn', t('crossesLine'));
    }
    if (row.t && row.t.since) {
      line(notes, 'sub', (row.t.state === 'bad' ? t('rejectedSince') : t('acceptedSince')) + ' ' + row.t.since);
    }
    if (row.t && row.t.fixed && row.t.state !== 'bad') line(notes, 'sub', t('fixedOn') + ' ' + row.t.fixed);
    for (var x = 0; x < (row.x || []).length; x++) {
      var conflict = row.x[x];
      line(notes, 'warn', t('conflictWith') + ' ' + conflict.with.join(', ') + ' (' + (conflict.kind === 'tool-name' ? t('conflictTool') : t('conflictEntry')) + ': ' + conflict.name + ', ' + t('predicted') + ')');
    }
    if (row.e) {
      var evidence = el('a', 'sub', t('evidence'));
      evidence.href = row.e;
      evidence.rel = 'nofollow';
      notes.appendChild(evidence);
    }
    if (row.q && row.q.length) {
      var details = el('details');
      details.appendChild(el('summary', null, t('declared')));
      details.appendChild(el('pre', null, row.q.join('\\n')));
      notes.appendChild(details);
    }
    tr.appendChild(notes);
    return tr;
  }

  function matches(row, needle, wantCat, status) {
    if (needle && row.n.toLowerCase().indexOf(needle) === -1) return false;
    if (wantCat && row.c !== wantCat) return false;
    var latest = data.latestIndex >= 0 ? row.s[data.latestIndex] : null;
    if (status === 'statusRejected' && latest !== 'bad') return false;
    if (status === 'statusAtRisk' && !row.f) return false;
    if (status === 'statusStale' && !(latest === 'bad' && row.b === 'V3')) return false;
    if (status === 'statusUndeclared' && latest !== 'none') return false;
    if (status === 'statusVerified' && row.l !== 'V3') return false;
    return true;
  }

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      var av = sortKey === 'name' ? a.n.toLowerCase() : (a.r || '0000-00-00');
      var bv = sortKey === 'name' ? b.n.toLowerCase() : (b.r || '0000-00-00');
      return av === bv ? 0 : (av < bv ? -1 : 1) * sortDir;
    });
  }

  function apply() {
    var needle = q.value.trim().toLowerCase();
    var wantCat = cat.value;
    var status = statusSel.value;
    var list = [];
    for (var i = 0; i < all.length; i++) if (matches(all[i], needle, wantCat, status)) list.push(all[i]);
    filtered = sortRows(list);
    if (pinned) {
      // A linked plugin is shown first, whatever the filters say.
      for (var p = 0; p < all.length; p++) {
        if (all[p].slug === pinned) {
          filtered = [all[p]].concat(filtered.filter(function (row) { return row.slug !== pinned; }));
          break;
        }
      }
    }
    tbody.textContent = '';
    shown = 0;
    renderMore();
  }

  function renderMore() {
    var end = Math.min(filtered.length, shown + PAGE);
    var fragment = document.createDocumentFragment();
    for (var i = shown; i < end; i++) fragment.appendChild(renderRow(filtered[i]));
    tbody.appendChild(fragment);
    shown = end;
    more.hidden = shown >= filtered.length;
    var totalRows = all.length;
    count.textContent = filtered.length === data.total && totalRows === data.total
      ? ''
      : t('shownOf').replace('{matched}', filtered.length).replace('{loaded}', totalRows);
    empty.hidden = filtered.length !== 0;
  }

  function applyLanguage(next) {
    lang = next;
    var table = dict[lang] || dict.en;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('title');
    var meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', t('description'));
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      var key = node.getAttribute('data-i18n');
      var text = t(key);
      if (key === 'healthy' || key === 'rejected' || key === 'atRiskTally') {
        text = text + ' (' + node.getAttribute('data-pct') + '%)';
      } else if (key === 'acceptedOnLatest' || key === 'rejectedOnLatest') {
        text = text + ' \\u2014 ' + node.getAttribute('data-host') + ' (' + node.getAttribute('data-pct') + '%)';
      } else if (key === 'ignoredTags') {
        text = text + node.getAttribute('data-list');
      } else if (key === 'hostLine') {
        text = text + ': ' + node.getAttribute('data-n') + ' · ' + t('accepted') + ': ' + node.getAttribute('data-ok');
      }
      node.textContent = text;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-placeholder]'), function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
    });
    var cats = table.categories || {};
    Array.prototype.forEach.call(document.querySelectorAll('option[data-cat-label]'), function (node) {
      var key = node.getAttribute('data-cat-label');
      node.textContent = cats[key] !== undefined ? cats[key] : key;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.lang button'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-lang') === lang ? 'true' : 'false');
    });
    try { localStorage.setItem('dsh-compat-lang', lang); } catch (e) {}
    apply();
  }

  function pinFromHash() {
    var match = /^#p-(.+)$/.exec(location.hash || '');
    pinned = match ? decodeURIComponent(match[1]) : null;
  }

  function scrollToPinned() {
    if (!pinned) return;
    var row = document.getElementById('p-' + pinned);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
  }

  q.addEventListener('input', apply);
  cat.addEventListener('change', apply);
  statusSel.addEventListener('change', apply);
  more.addEventListener('click', renderMore);
  window.addEventListener('hashchange', function () { pinFromHash(); apply(); scrollToPinned(); });
  Array.prototype.forEach.call(document.querySelectorAll('.lang button'), function (button) {
    button.addEventListener('click', function () { applyLanguage(button.getAttribute('data-lang')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      sortDir = sortKey === key ? -sortDir : 1;
      sortKey = key;
      apply();
    });
  });

  var stored = null;
  try { stored = localStorage.getItem('dsh-compat-lang'); } catch (e) {}
  var initial = stored === 'zh' || stored === 'en'
    ? stored
    : ((navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en');
  pinFromHash();
  applyLanguage(initial);
  scrollToPinned();

  if (data.rowsUrl && window.fetch) {
    fetch(data.rowsUrl).then(function (response) { return response.ok ? response.json() : null; }).then(function (rows) {
      if (!rows || !rows.length) return;
      all = rows;
      var partial = document.getElementById('partial');
      if (partial) partial.hidden = true;
      apply();
      scrollToPinned();
    }).catch(function () {});
  }
})();
</script>
</body>
</html>
`
}

/** Exported for tests and for the per-plugin documents. */
export { STRINGS, FAILURE_KINDS }
