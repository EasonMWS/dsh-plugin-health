/**
 * Render a compatibility matrix as a standalone HTML page.
 *
 * The matrix already knows, for every plugin and every host version, whether the declared ranges
 * admit that host. Until now that only existed as JSON in a CI artifact: downloadable behind a
 * login, expired after 90 days, unreadable to anyone who is not a maintainer. This turns the same
 * data into a page a user can be sent a link to.
 *
 * Everything is inlined — styles, script and data — because it is deployed as a static file with no
 * build step, and because a single self-contained file is the only thing GitHub Pages will serve
 * without surprises. 300–4,000 rows is small enough that client-side filter is instant.
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
 * Build the page.
 * @param {object} matrix - output of createMatrix()
 * @param {{title?: string, intro?: string, indexUrl?: string, toolVersion?: string}} [meta]
 * @returns {string} complete HTML document
 */
export function renderCompatPage(matrix, meta = {}) {
  const hosts = matrix.hosts ?? []
  const plugins = [...(matrix.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const generated = matrix.generatedAt ?? new Date().toISOString()

  const rows = plugins.map((plugin) => {
    const cells = hosts.map((host) => {
      const state = cellState(plugin.results?.[host])
      return `<td class="c ${state.cls}" title="${esc(state.label)}"><span aria-hidden="true">${state.glyph}</span><span class="sr">${esc(state.label)}</span></td>`
    }).join('')
    const incompatible = plugin.summary?.incompatible ?? 0
    const requirements = Object.entries(plugin.results ?? {})
      .flatMap(([host, result]) => Object.entries(result?.requirements ?? {}).map(([k, v]) => `${host}: ${k} ${v}`))
    return `<tr data-name="${esc(plugin.name.toLowerCase())}" data-bad="${incompatible > 0 ? '1' : '0'}">
      <th scope="row"><span class="name">${esc(plugin.name)}</span><span class="ver">${esc(plugin.version ?? '')}</span></th>
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
    return { host, ok, total }
  })

  const summaryLines = hostSummary.map((row) =>
    `<li><strong>${esc(row.host)}</strong>: ${row.ok} of ${row.total} plugins accept this host.</li>`).join('')

  const title = meta.title ?? 'DSH plugin compatibility'
  const description = `Which DeepSeek Harness plugins load on which host version. ${plugins.length} plugins, ${hosts.length} host versions, updated daily.`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — which plugins work on which DSH version</title>
<meta name="description" content="${esc(description)}">
<style>
  :root { color-scheme: light dark; --ok:#137333; --bad:#c5221f; --unk:#8a6d00; --line:#8883; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif; padding:0 20px 60px; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 40px 0 8px; letter-spacing: -.01em; }
  .lede { margin: 0 0 10px; opacity: .78; }
  .stamp { font-size: 12.5px; opacity: .55; margin: 0 0 22px; }
  .controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin: 0 0 4px; padding: 12px 0; position: sticky; top: 0; background: Canvas; }
  input[type=search] { flex: 1 1 240px; padding: 7px 11px; font: inherit; font-size: 14px; border: 1px solid var(--line); border-radius: 7px; background: Field; color: FieldText; }
  input[type=search]:focus { outline: 2px solid color-mix(in srgb, CanvasText 35%, transparent); outline-offset: 1px; }
  .chip { padding: 7px 13px; font: inherit; font-size: 13.5px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  .chip[aria-pressed=true] { background: CanvasText; color: Canvas; border-color: CanvasText; }
  #count { font-size: 12.5px; opacity: .55; }

  table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 14px; }
  thead th { padding: 8px 6px; font-size: 11.5px; font-weight: 600; text-align: left; opacity: .6; border-bottom: 1px solid var(--line); white-space: nowrap; }
  thead th:first-child { width: auto; text-transform: uppercase; letter-spacing: .04em; }
  thead th.c { width: 96px; text-align: center; }
  thead th.notes { width: 186px; text-transform: uppercase; letter-spacing: .04em; }
  tbody th { text-align: left; padding: 9px 6px; font-weight: 400; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  tbody td { padding: 9px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.c { width: 96px; text-align: center; }
  td.notes { width: 186px; }
  .name { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 13px; }
  .ver { opacity: .42; font-size: 11.5px; margin-left: 6px; }
  td.c { font-size: 15px; font-weight: 600; }
  td.c.ok { color: var(--ok); }
  td.c.bad { color: var(--bad); }
  td.c.unknown { color: var(--unk); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  .badge { display:inline-block; font-size: 11.5px; line-height: 1.35; color: var(--bad); }
  .notes details { margin-top: 3px; }
  .notes summary { font-size: 11.5px; opacity: .55; cursor: pointer; }
  .notes pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; opacity: .7; }

  .summary { margin: 26px 0 0; font-size: 13.5px; }
  .summary strong { display:block; margin-bottom: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .summary ul { margin: 0; padding-left: 18px; opacity: .8; }
  .caveat { margin: 26px 0 0; font-size: 13px; opacity: .72; border-left: 2px solid var(--line); padding-left: 14px; }
  footer { margin-top: 28px; font-size: 12.5px; opacity: .55; }
  a { color: inherit; }
  @media (max-width: 620px) {
    th.notes, td.notes { display: none; }
    th.c, td.c { width: 62px; }
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

  <div class="controls">
    <input type="search" id="q" placeholder="Filter by plugin name…" aria-label="Filter by plugin name">
    <button class="chip" id="onlyBad" aria-pressed="false">Only incompatible</button>
    <span id="count" class="stamp" style="margin:0"></span>
  </div>

  <table>
    <thead><tr><th scope="col" style="width:auto">Plugin</th>${headerCells}<th scope="col" class="notes">Notes</th></tr></thead>
    <tbody id="rows">
${rows}
    </tbody>
  </table>

  <div class="summary">
    <strong>By host version</strong>
    <ul>${summaryLines}</ul>
  </div>

  <p class="caveat"><strong>Read this before relying on a row.</strong> A tick means the plugin's
  declared ranges admit that host, so the installer will not reject it. It does not mean the plugin
  works, and it is not a security review. A plugin that is missing was never checked. When a plugin
  is marked incompatible the cause is usually a one-line range update in its <code>package.json</code>,
  which the maintainer has to ship — you cannot fix it locally.</p>

  <footer>
    Generated by <a href="https://github.com/EasonMWS/dsh-plugin-health">dsh-plugin-health</a>${
      meta.toolVersion ? ` ${esc(meta.toolVersion)}` : ''}${
      meta.indexUrl ? ` · <a href="${esc(meta.indexUrl)}">plugin index</a>` : ''} ·
    <a href="https://github.com/EasonMWS/dsh-plugin-health/issues">report a wrong row</a>
  </footer>
</main>
<script>
(function () {
  var q = document.getElementById('q');
  var onlyBad = document.getElementById('onlyBad');
  var count = document.getElementById('count');
  var rows = Array.prototype.slice.call(document.getElementById('rows').rows);
  var bad = false;
  function apply() {
    var needle = q.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hit = !needle || row.getAttribute('data-name').indexOf(needle) !== -1;
      if (bad && row.getAttribute('data-bad') !== '1') hit = false;
      row.hidden = !hit;
      if (hit) shown++;
    }
    count.textContent = shown === rows.length ? '' : shown + ' of ' + rows.length + ' shown';
  }
  q.addEventListener('input', apply);
  onlyBad.addEventListener('click', function () {
    bad = !bad;
    onlyBad.setAttribute('aria-pressed', bad ? 'true' : 'false');
    apply();
  });
  apply();
})();
</script>
</body>
</html>
`
}