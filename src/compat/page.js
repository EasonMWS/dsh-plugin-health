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
 * Build the page.
 * @param {object} matrix - output of createMatrix()
 * @param {{title?: string, intro?: string, indexUrl?: string, toolVersion?: string,
 *          catalog?: Map<string, {category?: string, added?: string}>}} [meta]
 * @returns {string} complete HTML document
 */
export function renderCompatPage(matrix, meta = {}) {
  const hosts = matrix.hosts ?? []
  const catalog = meta.catalog instanceof Map ? meta.catalog : new Map()
  const plugins = [...(matrix.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const generated = matrix.generatedAt ?? new Date().toISOString()

  const categories = new Set()
  const rows = plugins.map((plugin) => {
    const entry = catalog.get(plugin.name) ?? {}
    const category = typeof entry.category === 'string' && entry.category !== '' ? entry.category : 'uncategorized'
    categories.add(category)

    const cells = hosts.map((host) => {
      const state = cellState(plugin.results?.[host])
      return `<td class="c ${state.cls}" title="${esc(state.label)}"><span aria-hidden="true">${state.glyph}</span><span class="sr">${esc(state.label)}</span></td>`
    }).join('')

    const incompatible = plugin.summary?.incompatible ?? 0
    const requirements = Object.entries(plugin.results ?? {})
      .flatMap(([host, result]) => Object.entries(result?.requirements ?? {}).map(([k, v]) => `${host}: ${k} ${v}`))
    const released = dayOf(plugin.publishedAt)
    const categoryLabel = category.replace(/-/g, ' ')

    return `<tr data-name="${esc(plugin.name.toLowerCase())}" data-bad="${incompatible > 0 ? '1' : '0'}" data-cat="${esc(category)}" data-released="${esc(released)}">
      <th scope="row"><span class="name">${esc(plugin.name)}</span><span class="ver">${esc(plugin.version ?? '')}</span></th>
      <td class="cat"><span class="pill">${esc(categoryLabel)}</span></td>
      <td class="date">${released === '' ? '<span class="dim">—</span>' : esc(released)}</td>
      ${cells}
      <td class="notes">${incompatible > 0 ? `<span class="badge">rejected by ${incompatible}</span>` : ''}${
        requirements.length > 0 && incompatible > 0
          ? `<details><summary>declared</summary><pre>${esc(requirements.slice(0, 6).join('\n'))}</pre></details>`
          : ''}</td>
    </tr>`
  }).join('\n')

  const headerCells = hosts.map((host) => `<th scope="col" class="c">${esc(host)}</th>`).join('')
  const hostSummary = hosts.map((host) => {
    const total = plugins.length
    const ok = plugins.filter((plugin) => plugin.results?.[host]?.compatible === true).length
    const bad = plugins.filter((plugin) => plugin.results?.[host]?.compatible === false).length
    return { host, ok, bad, total }
  })
  const summaryLines = hostSummary.map((row) =>
    `<li><strong>${esc(row.host)}</strong> — ${row.bad} of ${row.total} plugins are rejected (${row.ok} accepted).</li>`).join('')

  const categoryOptions = [...categories].sort().map((category) =>
    `<option value="${esc(category)}">${esc(category.replace(/-/g, ' '))}</option>`).join('')

  const title = meta.title ?? 'DSH plugin compatibility'
  const description = `Which DeepSeek Harness plugins load on which host version. ${plugins.length} plugins, ${hosts.length} host versions, updated daily.`

  // Top-line counts. "Healthy" has to mean all hosts accept it, not the newest one — a plugin that
  // loads on rc.5 but not on `next` is not healthy, it is a warning.
  const total = plugins.length
  const healthy = plugins.filter((plugin) => (plugin.summary?.incompatible ?? 0) === 0
    && (plugin.summary?.errors ?? 0) === 0).length
  const rejected = plugins.filter((plugin) => (plugin.summary?.incompatible ?? 0) > 0).length
  const errored = plugins.filter((plugin) => (plugin.summary?.errors ?? 0) > 0).length
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100))

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — which plugins work on which DSH version</title>
<meta name="description" content="${esc(description)}">
<style>
  :root { color-scheme: light dark; --ok:#137333; --bad:#c5221f; --unk:#8a6d00; --line:#8883; --pill:#8881; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif; padding:0 20px 60px; }
  main { max-width: 940px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 40px 0 8px; letter-spacing: -.01em; }
  .lede { margin: 0 0 10px; opacity: .78; }
  .stamp { font-size: 12.5px; opacity: .55; margin: 0 0 18px; }

  .tally { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 20px; }
  .tally .cell { flex: 1 1 150px; border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
  .tally .n { font-size: 1.65rem; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .tally .k { font-size: 12px; opacity: .6; }
  .tally .ok .n { color: var(--ok); }
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
  footer { margin-top: 28px; font-size: 12.5px; opacity: .62; }\n  footer p { margin: 0 0 9px; }\n  .src { max-width: 72ch; line-height: 1.6; }
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
  <h1>${esc(title)}</h1>
  <p class="lede">DSH refuses to load a plugin when its declared version range excludes the host you
  run. This table checks every plugin in the community catalog against the current host versions, so
  you can tell before installing whether it will be rejected.</p>
  <p class="stamp">Updated ${esc(generated.slice(0, 16).replace('T', ' '))} UTC ·
    ${plugins.length} plugins × ${hosts.length} host versions</p>

  <div class="tally">
    <div class="cell"><span class="n">${total}</span><span class="k">plugins checked</span></div>
    <div class="cell ok"><span class="n">${healthy}</span><span class="k">load on every host (${pct(healthy)}%)</span></div>
    <div class="cell bad"><span class="n">${rejected}</span><span class="k">rejected by at least one (${pct(rejected)}%)</span></div>
  </div>

  <div class="controls">
    <input type="search" id="q" placeholder="Filter by plugin name…" aria-label="Filter by plugin name">
    <select id="cat" aria-label="Filter by category">
      <option value="">All categories</option>
      ${categoryOptions}
    </select>
    <button class="chip" id="onlyBad" aria-pressed="false">Only rejected</button>
    <span id="count"></span>
  </div>

  <table>
    <thead><tr>
      <th scope="col" data-sort="name">Plugin</th>
      <th scope="col" class="cat">Category</th>
      <th scope="col" class="date" data-sort="released">Released</th>
      ${headerCells}
      <th scope="col" class="notes">Notes</th>
    </tr></thead>
    <tbody id="rows">
${rows}
    </tbody>
  </table>
  <p class="empty" id="empty" hidden>No plugin matches those filters.</p>

  <div class="summary">
    <strong class="label">By host version</strong>
    <ul>${summaryLines}</ul>
  </div>

  <p class="caveat"><strong>Read this before relying on a row.</strong> A tick means the plugin's
  declared ranges admit that host, so the installer will not reject it. It does not mean the plugin
  works, and it is not a security review. "Released" is the publish date of the version shown, which
  tells you whether the maintainer has been active on the current host line. A plugin that is missing
  was never checked. When a plugin is marked rejected the cause is usually a one-line range update in
  its <code>package.json</code>, which the maintainer has to ship — you cannot fix it locally.</p>

  <footer>
    <p class="src"><strong>Where this comes from.</strong> The plugin list is the
    <a href="https://awesome-dsh-plugin.com/">awesome-dsh-plugin</a> community catalog, filtered to
    entries published on npm — ${total} of them here. A plugin that only exists as a GitHub repo or a
    tarball cannot be checked and is not counted. Each row compares the plugin's own
    <code>package.json</code> declarations (<code>engines.dsh</code>, peer ranges) against the host
    versions in the column headers; no plugin code is executed and nothing is installed. That is why
    a tick means "the installer accepts it", not "it works". Rebuilt once a day.</p>
    <p>Generated by <a href="https://github.com/EasonMWS/dsh-plugin-health">dsh-plugin-health</a>${
      meta.toolVersion ? ` ${esc(meta.toolVersion)}` : ''}${
      meta.indexUrl ? ` · <a href="${esc(meta.indexUrl)}">plugin index</a>` : ''} ·
    <a href="https://github.com/EasonMWS/dsh-plugin-health/issues">report a wrong row</a></p>
  </footer>
</main>
<script>
(function () {
  var q = document.getElementById('q');
  var cat = document.getElementById('cat');
  var onlyBad = document.getElementById('onlyBad');
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var tbody = document.getElementById('rows');
  var rows = Array.prototype.slice.call(tbody.rows);
  var bad = false;

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
    count.textContent = shown === rows.length ? rows.length + ' plugins' : shown + ' of ' + rows.length;
    empty.hidden = shown !== 0;
  }

  q.addEventListener('input', apply);
  cat.addEventListener('change', apply);
  onlyBad.addEventListener('click', function () {
    bad = !bad;
    onlyBad.setAttribute('aria-pressed', bad ? 'true' : 'false');
    apply();
  });

  // Sorting is only offered where the order is unambiguous. Rows are re-ordered in place; the
  // per-host columns are not sortable because "how many hosts reject this" is what people mean.
  var sortState = {};
  Array.prototype.forEach.call(document.querySelectorAll('thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      var dir = sortState[key] === 'asc' ? 'desc' : 'asc';
      sortState[key] = dir;
      var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
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

  apply();
})();
</script>
</body>
</html>
`
}