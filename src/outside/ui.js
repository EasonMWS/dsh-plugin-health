/**
 * The outside page: what a user sees when DSH is not running.
 *
 * Built as one self-contained module rather than a framework app — it is served by a local server
 * whose only job is to show three things (what is installed, whether it is safe to start, what to do
 * when the host will not) and it has no build step.
 *
 * The palette and type follow the in-DSH panel so the two do not look like different products:
 * accent #245fc5 on light, #91b7ff on dark, the same light-dark() idiom the panel already uses.
 * @module outside/ui
 */

/** The page, as a single string. Served once, no bundler, no external assets. */
export const OUTSIDE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件健康 · 局外工具</title>
<style>
  :root {
    color-scheme: light dark;
    --accent: light-dark(#245fc5, #91b7ff);
    --error: light-dark(#b42318, #ffaaa1);
    --warn: light-dark(#946000, #eec46a);
    --ok: light-dark(#18734a, #87d6aa);
    --line: light-dark(rgba(16,24,40,.12), rgba(255,255,255,.14));
    --tint: light-dark(rgba(16,24,40,.035), rgba(255,255,255,.045));
    --surface: light-dark(#ffffff, #171a20);
    --page: light-dark(#f6f7f9, #101216);
    --ink: light-dark(#1a2230, #e6eaf0);
    --muted: light-dark(#5b6675, #97a2b2);
    --radius: 14px;
    --speed: 200ms;
    --ease: cubic-bezier(.22, .61, .36, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    :root { --speed: 1ms; }
    * { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: var(--page); color: var(--ink);
    font-size: 14px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 940px; margin: 0 auto; padding: 28px 20px 64px; }

  /* --- header --- */
  header { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
  .brand { flex: 1 1 320px; min-width: 0; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 13px; margin: 0; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .chip {
    font-size: 12px; padding: 3px 9px; border-radius: 99px;
    border: 1px solid var(--line); color: var(--muted);
    display: inline-flex; align-items: center; gap: 5px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--ok); }
  .dot.poll { background: var(--warn); }
  .dot.busy { background: var(--accent); animation: pulse 1.2s var(--ease) infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

  /* --- cards --- */
  .card {
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 20px; margin-bottom: 16px;
    transition: box-shadow var(--speed) var(--ease), transform var(--speed) var(--ease);
  }
  .card:hover { box-shadow: 0 2px 14px light-dark(rgba(16,24,40,.07), rgba(0,0,0,.3)); }
  .card h2 { font-size: 15px; margin: 0 0 3px; display: flex; align-items: center; gap: 8px; }
  .card .hint { color: var(--muted); font-size: 13px; margin: 0 0 14px; }

  /* --- verdict --- */
  .verdict {
    display: flex; align-items: center; gap: 14px; padding: 16px 18px;
    border-radius: 12px; font-weight: 600; font-size: 15px;
    /* No opacity animation here: the verdict is the answer, and it must be readable from the first
       frame. The slide is enough to signal that something new arrived. */
    animation: slide var(--speed) var(--ease) both;
  }
  @keyframes slide { from { transform: translateY(5px) } to { transform: none } }
  @keyframes rise { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
  .verdict .mark {
    width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    font-size: 16px; flex: 0 0 30px;
  }
  .verdict.pass { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
  .verdict.pass .mark { background: color-mix(in srgb, var(--ok) 20%, transparent); }
  .verdict.warn { background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); }
  .verdict.warn .mark { background: color-mix(in srgb, var(--warn) 22%, transparent); }
  .verdict.block { background: color-mix(in srgb, var(--error) 12%, transparent); color: var(--error); }
  .verdict.block .mark { background: color-mix(in srgb, var(--error) 20%, transparent); }
  .verdict .body { flex: 1; min-width: 0; }
  .verdict .detail { font-weight: 400; font-size: 13px; opacity: .85; margin-top: 2px; }

  /* --- controls --- */
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  label.field { display: grid; gap: 5px; font-size: 12px; color: var(--muted); flex: 1 1 200px; }
  input[type="text"], input[type="search"] {
    font: inherit; font-size: 14px; padding: 9px 11px; width: 100%;
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--page); color: var(--ink);
    transition: border-color var(--speed) var(--ease), box-shadow var(--speed) var(--ease);
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  button {
    font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
    padding: 9px 18px; border-radius: 10px; border: 1px solid transparent;
    transition: background var(--speed) var(--ease), transform 90ms var(--ease), opacity var(--speed);
    background: var(--accent); color: light-dark(#fff, #0b1220);
  }
  button:hover:not(:disabled) { filter: brightness(1.06); }
  button:active:not(:disabled) { transform: translateY(1px) scale(.995); }
  button:disabled { opacity: .5; cursor: default; }
  button.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
  button.ghost:hover:not(:disabled) { background: var(--tint); }

  /* --- findings --- */
  .finding {
    display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line);
    animation: rise 260ms var(--ease) both;
  }
  .finding:first-of-type { border-top: 0; }
  .finding .sev {
    flex: 0 0 auto; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px; height: fit-content;
  }
  .sev.block { background: color-mix(in srgb, var(--error) 16%, transparent); color: var(--error); }
  .sev.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .finding .what { flex: 1; min-width: 0; }
  .finding .name { font-weight: 600; }
  .finding .why { color: var(--muted); font-size: 12.5px; margin-top: 2px; word-break: break-word; }
  .empty { color: var(--muted); padding: 10px 0; font-size: 13px; }

  /* --- stats --- */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-top: 4px; }
  .stat { border: 1px solid var(--line); border-radius: 11px; padding: 12px 14px; background: var(--page); }
  .stat strong { display: block; font-size: 22px; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .stat span { font-size: 12px; color: var(--muted); }

  /* --- limits --- */
  .limits { margin: 14px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
  .limits li {
    font-size: 11.5px; color: var(--muted); border: 1px dashed var(--line);
    border-radius: 8px; padding: 3px 8px;
  }

  /* --- sandbox --- */
  /* An element with the hidden attribute must stay hidden even when a class sets display. */
  [hidden] { display: none !important; }
  .sandbox-row {
    display: flex; align-items: flex-start; gap: 9px; margin-top: 12px;
    font-size: 13px; line-height: 1.5;
  }
  .sandbox-row input { margin-top: 3px; accent-color: var(--accent); }
  .sandbox-row .why { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  .sandbox-row.unavailable { color: var(--muted); }
  .sandbox-badge {
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px;
    background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok);
    margin-left: 6px;
  }

  /* --- plugins and market --- */
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .toolbar input[type="search"], .toolbar input[type="text"] { flex: 1 1 200px; }
  .counts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
  .counts b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }

  .plugin {
    display: flex; align-items: center; gap: 12px; padding: 10px 0;
    border-top: 1px solid var(--line); animation: rise 220ms var(--ease) both;
  }
  .plugin:first-of-type { border-top: 0; }
  .plugin .id { flex: 1; min-width: 0; }
  .plugin .name { font-weight: 600; word-break: break-all; }
  .plugin .meta { color: var(--muted); font-size: 12.5px; margin-top: 1px; }
  .plugin .meta .warn { color: var(--warn); }

  /* A switch, not a checkbox: in a list of thirty the state has to read at a glance. */
  .switch { position: relative; flex: 0 0 38px; width: 38px; height: 21px; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch .track {
    display: block; width: 38px; height: 21px; border-radius: 99px; position: relative;
    background: light-dark(rgba(16,24,40,.2), rgba(255,255,255,.22));
    transition: background var(--speed) var(--ease); pointer-events: none;
  }
  .switch .track::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 15px; height: 15px;
    border-radius: 50%; background: #fff; transition: transform var(--speed) var(--ease);
    box-shadow: 0 1px 3px rgba(0,0,0,.25);
  }
  .switch input:checked + .track { background: var(--ok); }
  .switch input:checked + .track::after { transform: translateX(17px); }
  .switch input:disabled { cursor: not-allowed; }
  .switch input:disabled + .track { opacity: .45; }
  .switch input:focus-visible + .track { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }

  .badge {
    flex: 0 0 auto; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px;
    white-space: nowrap;
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .badge.bad { background: color-mix(in srgb, var(--error) 16%, transparent); color: var(--error); }
  .badge.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .badge.mute { background: var(--tint); color: var(--muted); }

  .market-row { padding: 11px 0; border-top: 1px solid var(--line); animation: rise 220ms var(--ease) both; }
  .market-row:first-of-type { border-top: 0; }
  .market-row .head { display: flex; align-items: center; gap: 10px; }
  .market-row .head .name { font-weight: 600; flex: 1; min-width: 0; word-break: break-all; }
  .market-row .sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  .market-row .spec {
    display: inline-block; margin-top: 6px; padding: 3px 8px; border-radius: 7px;
    background: var(--page); border: 1px solid var(--line);
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px;
    cursor: copy;
  }
  .market-row .spec:hover { border-color: var(--accent); }
  .saved-source {
    font-size: 12px; padding: 3px 9px; border-radius: 99px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: var(--muted);
  }
  .saved-source:hover { border-color: var(--accent); color: var(--ink); }

  /* --- snapshots --- */
  .snap-row {
    display: flex; align-items: center; gap: 12px; padding: 11px 0;
    border-top: 1px solid var(--line); animation: rise 240ms var(--ease) both;
  }
  .snap-row:first-child { border-top: 0; }
  .snap-when { font-variant-numeric: tabular-nums; font-weight: 600; }
  .snap-meta { color: var(--muted); font-size: 12.5px; }
  .snap-actions { margin-left: auto; display: flex; gap: 6px; }
  .snap-actions button { padding: 5px 11px; font-size: 12.5px; }
  .diff { margin: 8px 0 0; padding: 10px 12px; border-radius: 9px; background: var(--page);
    border: 1px solid var(--line); font-size: 12.5px; display: grid; gap: 4px; }
  .diff .row { color: var(--muted); }
  .diff .row b { color: var(--ink); font-weight: 600; }
  .inline-note { margin-top: 10px; font-size: 12.5px; color: var(--muted); }

  footer { color: var(--muted); font-size: 12px; margin-top: 26px; display: flex; gap: 14px; flex-wrap: wrap; }
  .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(8px);
    background: var(--surface); color: var(--ink); border: 1px solid var(--line);
    border-radius: 11px; padding: 10px 16px; font-size: 13px; box-shadow: 0 8px 26px rgba(0,0,0,.16);
    opacity: 0; pointer-events: none; transition: opacity var(--speed) var(--ease), transform var(--speed) var(--ease);
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .skeleton {
    height: 14px; border-radius: 7px; background: linear-gradient(90deg, var(--tint), color-mix(in srgb, var(--tint) 45%, transparent), var(--tint));
    background-size: 200% 100%; animation: shimmer 1.3s linear infinite;
  }
  @keyframes shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <h1>插件健康 · 局外工具</h1>
      <p class="sub">DSH 没有运行时，用这个检查、快照和抢救。诊断正在运行的 DSH 请用面板。</p>
      <div class="chips">
        <span class="chip"><span class="dot" id="live-dot"></span><span id="live-text">连接中…</span></span>
        <span class="chip" id="profile-chip">profile —</span>
        <span class="chip" id="rev-chip">rev —</span>
      </div>
    </div>
  </header>

  <section class="card">
    <h2>启动前检查</h2>
    <p class="hint">查一下这个 profile 能不能安全启动。只读文件和声明，不执行任何插件代码。</p>
    <div class="row">
      <label class="field">准备使用的 DSH 版本
        <input type="text" id="target" placeholder="留空表示当前版本">
      </label>
      <button id="check">检查</button>
      <button id="launch" class="ghost" disabled title="先检查一次">启动 DSH</button>
    </div>
    <div class="sandbox-row" id="sandbox-row" hidden>
      <input type="checkbox" id="sandbox-toggle">
      <div>
        <label for="sandbox-toggle">在沙箱里启动</label>
        <div class="why" id="sandbox-why"></div>
      </div>
    </div>
    <div class="sandbox-row unavailable" id="sandbox-note" hidden></div>
    <div id="verdict-slot"></div>
  </section>

  <section class="card">
    <h2>发现的问题</h2>
    <p class="hint" id="findings-hint">还没有检查。</p>
    <div id="findings"></div>
    <ul class="limits" id="limits"></ul>
  </section>

  <section class="card" id="plugins">
    <h2>已安装的插件</h2>
    <p class="hint">关掉一个插件只是让它不加载，文件不动，随时可以打开。改动前会自动存一份快照。</p>
    <div class="toolbar">
      <input type="search" id="plugin-filter" placeholder="按名字筛选">
      <button id="plugins-reload" class="ghost">刷新</button>
    </div>
    <div class="counts" id="plugin-counts"></div>
    <div id="plugin-list"></div>
  </section>

  <section class="card" id="market">
    <h2>插件市场</h2>
    <p class="hint">看市场里的插件在你要用的 DSH 版本上能不能用。安装仍然在 DSH 里做，这里只判断。</p>
    <div class="toolbar">
      <input type="text" id="market-source" placeholder="市场索引地址，或本地 JSON 文件路径">
      <button id="market-load">查看</button>
      <button id="market-save" class="ghost">记住来源</button>
    </div>
    <div class="toolbar" id="market-saved" hidden></div>
    <div class="counts" id="market-counts"></div>
    <div id="market-list"></div>
  </section>

  <section class="card">
    <h2>快照</h2>
    <p class="hint">保存当前配置，出问题时能退回来。只存配置文件和补丁层，不含插件本体。</p>
    <div class="row">
      <button id="snap-take" class="ghost">现在存一份</button>
      <span class="inline-note" id="snap-usage"></span>
    </div>
    <div id="snap-list"></div>
  </section>

  <footer>
    <span>局外工具只做 DSH 做不到的事：启动前判断、快照、崩溃抢救。</span>
    <span id="mode-note"></span>
  </footer>
</div>
<div class="toast" id="toast"></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id)
  const state = { key: null, checking: false, lastReport: null, rev: 0, plugins: null }

  // --- toast ---
  let toastTimer
  const toast = (text) => {
    const el = $('toast')
    el.textContent = text
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600)
  }

  const severityLabel = { block: '阻断', warn: '注意', info: '提示' }
  const kindLabel = {
    'would-be-rejected': '插件会被拒绝加载',
    'install-script': '包含安装脚本',
  }

  // --- connect to the event stream, so the page updates when the other half writes ---
  const connect = () => {
    let es
    try { es = new EventSource('/events') } catch { return }
    es.onopen = () => {
      $('live-dot').className = 'dot live'
      $('live-text').textContent = '已连接'
    }
    es.onerror = () => {
      $('live-dot').className = 'dot poll'
      $('live-text').textContent = '重连中…'
    }
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.hello) { state.rev = data.rev; paintRev(); return }
        if (typeof data.rev === 'number' && data.rev !== state.rev) {
          state.rev = data.rev
          paintRev()
          // A change from the other half: re-read rather than guessing what changed.
          if (state.lastReport !== null) runCheck({ quiet: true })
        }
      } catch { /* ignore a malformed frame */ }
    }
  }

  const paintRev = () => { $('rev-chip').textContent = 'rev ' + state.rev }

  // --- is DSH already running? ---
  // Starting a second copy gives two tray icons and two sets of plugins writing one profile. The server
  // knows; the page should say so rather than let the user find out.
  const paintHostState = (status) => {
    const button = $('launch')
    if (status?.running === true) {
      button.textContent = 'DSH 正在运行'
      button.title = 'pid ' + status.pid + '，' + (status.at || '未知时间') + ' 启动'
      button.disabled = true
      return
    }
    button.textContent = state.lastReport?.verdict === 'block' ? '仍然启动' : '启动 DSH'
    button.title = state.lastReport?.verdict === 'block'
      ? '检查发现了阻断项，启动后 DSH 可能起不来'
      : '用当前配置启动 DSH'
    button.disabled = state.lastReport === null
  }

  const loadHostState = async () => {
    try {
      const response = await fetch('/host', { cache: 'no-store' })
      paintHostState(await response.json())
    } catch { /* the button keeps its previous state */ }
  }

  // --- sandbox capability ---
  // Asked once at start. When the platform cannot sandbox, the row explains why instead of offering a
  // control that would do nothing.
  const loadSandboxCapability = async () => {
    try {
      const response = await fetch('/sandbox', { cache: 'no-store' })
      const body = await response.json()

      if (body.available === true) {
        $('sandbox-row').hidden = false
        $('sandbox-toggle').checked = true
        $('sandbox-why').textContent = body.kind === 'bubblewrap'
          ? 'bubblewrap：不能写 profile 以外的地方，不能联网，不能起子进程。'
          : 'sandbox-exec：不能写 profile 以外的地方，不能联网。'
        return
      }

      $('sandbox-note').hidden = false
      $('sandbox-note').textContent = '这台机器不能用沙箱启动：' + body.reason
    } catch {
      $('sandbox-note').hidden = false
      $('sandbox-note').textContent = '无法确认沙箱是否可用，启动时不会启用。'
    }
  }

  // --- load the shared state ---
  const loadState = async () => {
    try {
      const response = await fetch('/state', { cache: 'no-store' })
      const body = await response.json()
      state.key = body.key ?? null
      state.rev = body.state?.rev ?? 0
      paintRev()
      $('profile-chip').textContent = 'profile ' + (body.profile ?? '?')
      $('mode-note').textContent = body.watchMode === 'watch'
        ? '文件监听生效，变化即时同步'
        : '文件监听不可用，已降级为定时检查'
      $('live-dot').className = 'dot ' + (body.watchMode === 'watch' ? 'live' : 'poll')
      $('live-text').textContent = body.watchMode === 'watch' ? '实时同步' : '定时同步'
    } catch {
      $('live-text').textContent = '无法连接'
    }
  }

  // --- render the report ---
  const renderVerdict = (report) => {
    const slot = $('verdict-slot')
    slot.innerHTML = ''
    if (!report) return
    const text = {
      pass: ['可以启动', '当前 ' + report.pluginCount + ' 个插件的声明都认可这个版本。'],
      warn: ['可以启动，但有需要留意的地方', '没有插件会被拒绝，下面是具体内容。'],
      block: ['不建议直接启动', report.findings.filter(f => f.severity === 'block').length + ' 个插件会被拒绝加载。'],
    }[report.verdict] ?? ['未知', '']
    const el = document.createElement('div')
    el.className = 'verdict ' + report.verdict
    el.style.marginTop = '14px'
    el.innerHTML = '<div class="mark">' + (report.verdict === 'pass' ? '✓' : report.verdict === 'block' ? '!' : '·') + '</div>'
      + '<div class="body"><div>' + text[0] + '</div><div class="detail">' + text[1] + '</div></div>'
    slot.appendChild(el)
  }

  const renderFindings = (report) => {
    const host = $('findings')
    host.innerHTML = ''
    if (!report) { $('findings-hint').textContent = '还没有检查。'; return }
    const rows = report.findings ?? []
    $('findings-hint').textContent = rows.length === 0
      ? '没有发现需要处理的问题。'
      : rows.length + ' 条，按严重程度排列。'

    // Blocking first: those are the ones that stop the host from starting.
    const order = { block: 0, warn: 1, info: 2 }
    for (const finding of [...rows].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))) {
      const row = document.createElement('div')
      row.className = 'finding'
      const detail = finding.detail?.hooks
        ? '安装时执行：' + finding.detail.hooks.join('、')
        : Object.entries(finding.detail ?? {}).map(([k, v]) => k + ': ' + v).join('，')
      row.innerHTML = '<span class="sev ' + finding.severity + '">' + (severityLabel[finding.severity] ?? finding.severity) + '</span>'
        + '<div class="what"><div class="name">' + escapeHtml(finding.plugin) + (finding.version ? ' @ ' + escapeHtml(finding.version) : '') + '</div>'
        + '<div class="why">' + escapeHtml(kindLabel[finding.kind] ?? finding.kind) + (detail ? ' · ' + escapeHtml(detail) : '') + '</div></div>'
      host.appendChild(row)
    }

    const limits = $('limits')
    limits.innerHTML = ''
    const labels = {
      'declarations-and-files-only': '只读了声明和文件',
      'install-hooks-reported-not-executed': '安装脚本只报告，没有执行',
      'no-runtime-behaviour-observed': '没有观察运行时行为',
    }
    for (const limit of report.limits ?? []) {
      const li = document.createElement('li')
      li.textContent = labels[limit] ?? limit.replace('transitive-tree-capped-at-', '依赖树最多扫描 ') + ' 个包'
      limits.appendChild(li)
    }
  }

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))

  // --- the check ---
  const runCheck = async ({ quiet = false } = {}) => {
    if (state.checking) return
    state.checking = true
    const button = $('check')
    button.disabled = true
    if (!quiet) {
      button.textContent = '检查中…'
      $('findings').innerHTML = '<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:45%;margin-top:8px"></div>'
    }
    try {
      const target = $('target').value.trim()
      const query = target === '' ? '' : '?target=' + encodeURIComponent(target)
      const response = await fetch('/admission' + query, { cache: 'no-store' })
      const report = await response.json()
      if (report.error) { toast('检查失败：' + report.error); return }
      state.lastReport = report
      renderVerdict(report)
      renderFindings(report)
      paintHostState(undefined)
      // Persist the result so the panel inside DSH can recognise it as still valid.
      await fetch('/admission', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-health-key': state.key ?? '' },
        body: JSON.stringify({ admission: report }),
      }).catch(() => {})
      if (!quiet) toast(report.verdict === 'pass' ? '检查通过' : '检查完成，见下方')
    } catch (error) {
      toast('检查失败：' + (error?.message ?? error))
    } finally {
      state.checking = false
      button.disabled = false
      button.textContent = '检查'
    }
  }

  // --- plugins ---
  // The list is what a manager acts on. Host packages are counted but not offered: switching one off would
  // be switching off DSH.
  const compatibilityBadge = (row) => {
    if (row.hostPackage === true) return { cls: 'mute', text: '宿主' }
    if (row.compatibility === 'compatible') return { cls: 'ok', text: '可用' }
    if (row.compatibility === 'incompatible') return { cls: 'bad', text: '会被拒' }
    if (row.compatibility === 'exempted') return { cls: 'warn', text: '已豁免' }
    return { cls: 'mute', text: '未知' }
  }

  const paintPlugins = (data) => {
    state.plugins = data
    const host = $('plugin-list')
    const filter = $('plugin-filter').value.trim().toLowerCase()
    host.innerHTML = ''

    const rows = (data.plugins ?? []).filter((row) => {
      if (filter !== '' && !row.name.toLowerCase().includes(filter)) return false
      return true
    })

    const counts = $('plugin-counts')
    counts.innerHTML = ''
    const add = (label, value, cls) => {
      const span = document.createElement('span')
      span.innerHTML = label + ' <b>' + value + '</b>'
      if (cls) span.className = cls
      counts.appendChild(span)
    }
    add('可管理', data.counts?.manageable ?? 0)
    add('已关闭', data.counts?.disabled ?? 0)
    add('会被拒', (data.plugins ?? []).filter((row) => row.compatibility === 'incompatible').length)

    if (rows.length === 0) {
      host.innerHTML = '<div class="empty">没有匹配的插件。</div>'
      return
    }

    for (const row of rows) {
      const item = document.createElement('div')
      item.className = 'plugin'

      const badge = compatibilityBadge(row)
      const id = document.createElement('div')
      id.className = 'id'
      const reason = row.reason ? ' · <span class="warn">' + escapeHtml(row.reason) + '</span>' : ''
      id.innerHTML = '<div class="name">' + escapeHtml(row.name) + '</div>'
        + '<div class="meta">' + escapeHtml(row.version ?? '未安装') + reason + '</div>'

      const badgeEl = document.createElement('span')
      badgeEl.className = 'badge ' + badge.cls
      badgeEl.textContent = badge.text

      // A host package cannot be switched off from here, so it gets no switch at all rather than a disabled
      // one that suggests it could be.
      item.append(id, badgeEl)

      if (row.hostPackage !== true && row.version !== null) {
        const label = document.createElement('label')
        label.className = 'switch'
        label.title = row.enabled ? '点击关闭' : '点击启用'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = row.enabled === true
        input.addEventListener('change', () => togglePlugin(row, input))
        label.append(input, Object.assign(document.createElement('span'), { className: 'track' }))
        item.appendChild(label)
      }

      host.appendChild(item)
    }
  }

  const togglePlugin = async (row, input) => {
    input.disabled = true
    try {
      const response = await fetch('/plugins/enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-health-key': state.key ?? '' },
        body: JSON.stringify({ name: row.name, enabled: input.checked }),
      })
      const body = await response.json()

      if (body.ok !== true) {
        // Put the switch back where it was: a control that lies about the state is worse than one that
        // refuses.
        input.checked = row.enabled === true
        toast(body.reason === 'host-running'
          ? 'DSH 正在运行，先关掉它再改插件状态'
          : (body.error ?? '操作失败'))
        return
      }

      row.enabled = input.checked
      toast((input.checked ? '已启用 ' : '已关闭 ') + row.name
        + (typeof body.snapshot === 'string' ? '（已存快照）' : ''))
      loadSnapshots()
    } catch (error) {
      input.checked = row.enabled === true
      toast('操作失败：' + (error?.message ?? error))
    } finally {
      input.disabled = false
    }
  }

  const loadPlugins = async () => {
    try {
      const response = await fetch('/plugins', { cache: 'no-store' })
      const data = await response.json()
      if (data.ok !== true) {
        $('plugin-list').innerHTML = '<div class="empty">' + escapeHtml(data.error ?? '读不到插件列表') + '</div>'
        return
      }
      paintPlugins(data)
    } catch (error) {
      $('plugin-list').innerHTML = '<div class="empty">读不到插件列表：' + escapeHtml(String(error?.message ?? error)) + '</div>'
    }
  }

  $('plugins-reload').addEventListener('click', loadPlugins)
  $('plugin-filter').addEventListener('input', () => { if (state.plugins !== null) paintPlugins(state.plugins) })

  // --- market ---
  const judgeBadge = (row) => {
    if (row.verdict === 'compatible') return { cls: 'ok', text: '可用' }
    if (row.verdict === 'incompatible') return { cls: 'bad', text: '会被拒' }
    return { cls: 'mute', text: '未知' }
  }

  const paintMarket = (data) => {
    const counts = $('market-counts')
    counts.innerHTML = ''
    if (data.error) {
      $('market-list').innerHTML = '<div class="empty">' + escapeHtml(data.error) + '</div>'
      return
    }
    const add = (label, value) => {
      const span = document.createElement('span')
      span.innerHTML = label + ' <b>' + value + '</b>'
      counts.appendChild(span)
    }
    add('条目', data.total)
    add('可用', data.counts?.compatible ?? 0)
    add('会被拒', data.counts?.incompatible ?? 0)
    add('已装', data.installedCount ?? 0)
    if (data.judgedAgainst) add('对照版本', escapeHtml(data.judgedAgainst))

    const host = $('market-list')
    host.innerHTML = ''
    if ((data.plugins ?? []).length === 0) {
      host.innerHTML = '<div class="empty">这个市场里没有插件。</div>'
      return
    }

    for (const row of data.plugins) {
      const item = document.createElement('div')
      item.className = 'market-row'
      const badge = judgeBadge(row)

      const head = document.createElement('div')
      head.className = 'head'
      head.innerHTML = '<div class="name">' + escapeHtml(row.title) + '</div>'
      const badgeEl = document.createElement('span')
      badgeEl.className = 'badge ' + badge.cls
      badgeEl.textContent = badge.text
      head.appendChild(badgeEl)

      const sub = document.createElement('div')
      sub.className = 'sub'
      const bits = [escapeHtml(row.name)]
      if (row.latestVersion) bits.push('最新 ' + escapeHtml(row.latestVersion))
      if (row.usableVersion && row.usableVersion !== row.latestVersion) bits.push('可用 ' + escapeHtml(row.usableVersion))
      if (row.installed) bits.push('已装 ' + escapeHtml(row.installedVersion ?? '?'))
      if (row.reason) bits.push('<span class="warn">' + escapeHtml(row.reason) + '</span>')
      sub.innerHTML = bits.join(' · ')

      item.append(head, sub)

      // The install spec is shown as text to copy, never as a button: installing belongs to DSH.
      if (row.installSpec) {
        const spec = document.createElement('div')
        spec.className = 'spec'
        spec.textContent = row.installSpec
        spec.title = '点击复制；在 DSH 里安装'
        spec.addEventListener('click', () => {
          try {
            navigator.clipboard?.writeText(row.installSpec)
            toast('已复制安装标识')
          } catch { toast(row.installSpec) }
        })
        item.appendChild(spec)
      }

      host.appendChild(item)
    }
  }

  const loadMarket = async () => {
    const source = $('market-source').value.trim()
    if (source === '') { toast('先填市场地址'); return }
    $('market-list').innerHTML = '<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%;margin-top:8px"></div>'
    try {
      const target = $('target').value.trim()
      const query = new URLSearchParams({ source })
      if (target !== '') query.set('target', target)
      const response = await fetch('/market?' + query.toString(), { cache: 'no-store' })
      paintMarket(await response.json())
    } catch (error) {
      paintMarket({ error: String(error?.message ?? error) })
    }
  }

  const paintSources = (sources) => {
    const host = $('market-saved')
    host.innerHTML = ''
    if ((sources ?? []).length === 0) { host.hidden = true; return }
    host.hidden = false
    const label = document.createElement('span')
    label.className = 'counts'
    label.textContent = '已记住：'
    host.appendChild(label)
    for (const source of sources) {
      const button = document.createElement('button')
      button.className = 'saved-source'
      button.textContent = source.label
      button.title = source.url
      button.addEventListener('click', () => { $('market-source').value = source.url; loadMarket() })
      host.appendChild(button)
    }
  }

  const loadSources = async () => {
    try {
      const response = await fetch('/market/sources', { cache: 'no-store' })
      paintSources((await response.json()).sources)
    } catch { /* the list is a convenience */ }
  }

  $('market-load').addEventListener('click', loadMarket)
  $('market-source').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadMarket() })
  $('market-save').addEventListener('click', async () => {
    const source = $('market-source').value.trim()
    if (source === '') { toast('先填市场地址'); return }
    try {
      const response = await fetch('/market/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-health-key': state.key ?? '' },
        body: JSON.stringify({ url: source }),
      })
      const body = await response.json()
      if (body.ok !== true) { toast(body.error ?? '记住失败'); return }
      paintSources(body.sources)
      toast('已记住')
    } catch (error) {
      toast('记住失败：' + (error?.message ?? error))
    }
  })

  // --- snapshots ---
  const paintUsage = (usage) => {
    const mb = (usage.bytes / 1048576).toFixed(2)
    $('snap-usage').textContent = usage.count === 0
      ? '还没有快照'
      : usage.count + ' 份，共 ' + mb + ' MB'
  }

  const loadSnapshots = async () => {
    try {
      const response = await fetch('/snapshots', { cache: 'no-store' })
      const body = await response.json()
      paintUsage(body.usage ?? { count: 0, bytes: 0 })
      const host = $('snap-list')
      host.innerHTML = ''
      for (const snap of body.snapshots ?? []) {
        const row = document.createElement('div')
        row.className = 'snap-row'
        const when = new Date(snap.at)
        const label = when.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        row.innerHTML = '<div><div class="snap-when">' + escapeHtml(label) + '</div>'
          + '<div class="snap-meta">' + escapeHtml(snap.reason) + ' · ' + snap.files.length + ' 个文件</div></div>'
        const actions = document.createElement('div')
        actions.className = 'snap-actions'

        const preview = document.createElement('button')
        preview.className = 'ghost'
        preview.textContent = '预览恢复'
        preview.addEventListener('click', () => restore(snap.id, false))

        const apply = document.createElement('button')
        apply.className = 'ghost'
        apply.textContent = '恢复'
        apply.addEventListener('click', () => restore(snap.id, true))

        actions.append(preview, apply)
        row.appendChild(actions)
        host.appendChild(row)
      }
      if ((body.snapshots ?? []).length === 0) {
        host.innerHTML = '<div class="empty">还没有快照。出问题前先存一份，恢复时才有东西可退。</div>'
      }
    } catch { /* the page still works without the list */ }
  }

  const restore = async (id, apply) => {
    try {
      const response = await fetch('/snapshots/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-health-key': state.key ?? '' },
        body: JSON.stringify({ id, apply }),
      })
      const body = await response.json()
      if (body.error) { toast('恢复失败：' + body.error); return }

      // Show what the restore would touch, every time. Restoring overwrites live configuration, and a
      // user should see which files before it happens, not after.
      const host = $('snap-list')
      const old = host.querySelector('.diff')
      if (old) old.remove()
      const box = document.createElement('div')
      box.className = 'diff'
      const rows = (body.plan?.changes ?? []).map((c) =>
        '<div class="row"><b>' + escapeHtml(c.file) + '</b> · ' + ({
          create: '会被创建', overwrite: '会被覆盖', unchanged: '没有变化',
        }[c.change] ?? c.change) + '</div>').join('')
      box.innerHTML = rows || '<div class="row">没有需要改动的文件。</div>'
      if (body.plan?.applied === true) {
        box.innerHTML += '<div class="row">已恢复。恢复前的状态存为 <b>' + escapeHtml(body.plan.safetySnapshot ?? '') + '</b>。</div>'
      }
      host.prepend(box)

      toast(body.plan?.applied === true ? '已恢复' : '预览完成，确认后再点恢复')
      if (body.plan?.applied === true) loadSnapshots()
    } catch (error) {
      toast('恢复失败：' + (error?.message ?? error))
    }
  }

  // --- launch ---
  // Kept as a name the check flow already calls; it now defers to the host state, which knows whether
  // something is already running.
  const paintLaunch = (report) => {
    if (report !== null) state.lastReport = report
    paintHostState(undefined)
  }

  $('launch').addEventListener('click', async () => {
    const button = $('launch')
    const report = state.lastReport
    if (report === null) { toast('先检查一次'); return }
    if (report.verdict === 'block' && !confirm('检查发现了阻断项，DSH 可能起不来。仍然启动？')) return

    button.disabled = true
    button.textContent = '启动中…'
    try {
      const response = await fetch('/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-health-key': state.key ?? '' },
        body: JSON.stringify({
          start: true,
          target: $('target').value.trim(),
          sandbox: $('sandbox-toggle').checked === true,
        }),
      })
      const body = await response.json()
      if (body.error) { toast('启动失败：' + body.error); return }
      if (body.launched === true) {
        toast(body.sandboxed === true ? '已在沙箱中启动 DSH' : '已启动 DSH（未启用沙箱）')
        loadHostState()
      } else {
        // A sandbox that could not be applied is reported as itself, not as a generic failure.
        if (body.alreadyRunning === true) {
          toast(body.stopped ?? 'DSH 已经在运行')
          loadHostState()
        } else {
          toast(body.sandboxUnsupported === true ? '无法沙箱启动：' + body.error : (body.error ?? body.stopped ?? '没有启动'))
        }
      }
    } catch (error) {
      toast('启动失败：' + (error?.message ?? error))
    } finally {
      button.disabled = false
      paintLaunch(state.lastReport)
    }
  })

  $('snap-take').addEventListener('click', async () => {
    const button = $('snap-take')
    button.disabled = true
    try {
      const response = await fetch('/snapshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-health-key': state.key ?? '' },
        body: JSON.stringify({ reason: 'manual' }),
      })
      const body = await response.json()
      toast(body.ok === true ? '已保存快照' : '保存失败：' + (body.error ?? '未知'))
      await loadSnapshots()
    } catch (error) {
      toast('保存失败：' + (error?.message ?? error))
    } finally {
      button.disabled = false
    }
  })

  $('check').addEventListener('click', () => runCheck())
  $('target').addEventListener('keydown', (event) => { if (event.key === 'Enter') runCheck() })

  loadState().then(() => { connect(); loadSnapshots(); loadSandboxCapability(); loadHostState(); loadPlugins(); loadSources() })
})()
</script>
</body>
</html>`
