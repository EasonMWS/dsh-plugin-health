# dsh-plugin-health

[![CI](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml/badge.svg)](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-health.svg)](https://www.npmjs.com/package/dsh-plugin-health)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Compatibility matrix, official format-1 index builder, and Windows/WSL install doctor for
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugins — with a native
settings UI inside DSH.

> Status: `0.2.0`. Built against the official DSH `0.2.1-rc.2` compatibility rules and the
> published `@deepseek-ai/dsh-plugin-market-index` validator.

**Live official format-1 index:** <https://easonmws.github.io/dsh-plugin-health/index.json>
(300 plugins, rebuilt nightly) · **npm:** `npm install -g dsh-plugin-health` ·
**repo:** <https://github.com/EasonMWS/dsh-plugin-health>

## A real UI, only when you need it

Install it as a bundle and DSH gets a native **Settings → 插件健康** section:

```sh
dsh plugin --profile web add dsh-plugin-health
```

- Every finding is written in plain language with a concrete next step — a first-time user can act
  without reading CLI docs.
- **If nothing is wrong, nothing is shown.** The plugin adds no badge, no banner, no sidebar entry.
- **When something is wrong**, a compact `插件有 N 个问题` entry appears above the account menu and
  jumps straight to the section.
- The host half only serves a loopback-only read-only snapshot; the plugin never modifies your
  profile.

> **Upgrading to DSH 0.2.1? Run the check first.**
>
> In a scan of the top 120 ecosystem plugins, **3 would stop loading on `0.2.1-rc.2`** because
> they pin exact `@deepseek-ai/*` peer versions (2 by default `latest` installs as of 2026-10-20).
> Full report: [docs/upgrade-0.2.1.md](docs/upgrade-0.2.1.md).
>
> ```sh
> dsh-plugin-health matrix --plugins plugins.txt --versions 0.2.0-rc.2,0.2.1-rc.2
> ```

## Why

DSH ships no official plugin market index, publishes a prerelease roughly every two days with
breaking changes, and its plugin manager has no version picker or upgrade action. Today an author
can only check a plugin against the one DSH version installed on the machine, and Windows/WSL
install failures leave partial directories and stale locks behind.

This tool covers the three gaps that the existing doctor/market tools do not:

1. **Multi-host compatibility matrix** — will a plugin load on `0.1.7-rc.2`, `0.2.0-rc.2`,
   `0.2.1-alpha.4`, `0.2.1-rc.2`, ...? Evaluated with the exact official semantics
   (`engines.dsh` first, otherwise `@deepseek-ai/dsh*` peers, prereleases included,
   `workspace:` ranges mapped to the host version).
2. **Official format-1 market index** — turn a community catalog into a JSON index that the
   built-in DSH **Discover** tab accepts, validated by the same parser the DSH Host uses.
3. **Windows/WSL install doctor** — read-only by default; repairs quarantine, never delete, and
   patch edits keep the user's comments.

## Install

```sh
npm install -g dsh-plugin-health
# or run the checkout:
git clone https://github.com/EasonMWS/dsh-plugin-health.git && cd dsh-plugin-health && npm ci
node bin/dsh-plugin-health.js --help
```

Requires Node.js 20+.

### Install inside DSH (bundle mode)

The package is also an installable DSH bundle. Installing it into a profile adds a read-only
`plugin_health` agent tool that reports missing third-party bundles, broken package directories,
`cordis.patch.yml` residue, proxy/registry configuration, profile drift, and installed plugins
incompatible with the running DSH version.

```sh
dsh plugin --profile web add dsh-plugin-health
```

The bundle declares `engines.dsh`, adds no UI, and changes nothing by itself.

## 1. Compatibility matrix

```sh
dsh-plugin-health matrix \
  --plugins examples/plugins.txt \
  --versions latest,next,alpha,0.1.7-rc.2 \
  --out dsh-health-out/matrix \
  --fail-on any
```

- `--plugins` accepts a file (one spec per line, `#` comments allowed), a comma list, or repeated
  flags. A spec is `name`, `name@version`, or a local plugin directory.
- `--versions` accepts exact SemVer versions or npm dist-tags of `@deepseek-ai/dsh`
  (`latest`, `next`, `alpha`, ...).
- Output: `matrix.json`, `matrix.md`, and static SVG badges (`badges/`).
- `--fail-on any|none|<host>` makes the command usable as a CI gate.

The evaluation mirrors `packages/boot/app-boot/src/plugin-compatibility.ts`:

| Manifest declares | Check |
|---|---|
| `engines.dsh` | that range alone; peers are ignored |
| no `engines.dsh`, has peers | every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range |
| peer range `workspace:^` / `~` / `*` | the running host version |
| prerelease host versions | participate in ranges (`includePrerelease: true`) |

Limitations: the matrix is **static** (manifests + official requirements). It does not yet boot
each host and mount the plugin; that runtime smoke test is on the roadmap. Git-only plugins can be
checked from a local clone with a directory spec.

### Example run (2026-10-17, 7 plugins × 4 hosts)

```
dsh 0.1.7-rc.2: 6/7 compatible, 1 incompatible
dsh 0.2.0-rc.2: 5/7 compatible, 2 incompatible
dsh 0.2.1-alpha.4: 5/7 compatible, 2 incompatible
dsh 0.2.1-rc.2: 5/7 compatible, 2 incompatible
✗ dsh-win32@0.17.14: incompatible on all four (narrow @deepseek-ai/dsh-subprocess-local peers)
✗ dsh-find-plugin@0.4.0: incompatible from 0.2.0-rc.2 (@deepseek-ai/dsh-tools peer)
```

The first result reproduces the real failure tracked in `dsh-win32` issue #89 (a peer upper bound
that is too narrow for later host lines) without installing anything.

### GitHub Action: matrix on every pull request

The repository ships a reusable workflow. Add
[`examples/dsh-compat.yml`](examples/dsh-compat.yml) to a plugin repository (as
`.github/workflows/dsh-compat.yml`) and every pull request gets a compatibility matrix comment plus
a job summary, with the matrix artifact uploaded:

```yaml
name: dsh plugin compatibility
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  matrix:
    uses: EasonMWS/dsh-plugin-health/.github/workflows/matrix-review.yml@v0.1.5
    with:
      plugins: '.'
      versions: 'latest,next,alpha'
      comment: true
```

## 2. Format-1 market index

```sh
dsh-plugin-health index \
  --catalog https://awesome-dsh-plugin.com/plugins.json \
  --host 0.2.1-rc.2 \
  --index-url https://easonmws.github.io/dsh-plugin-health/index.json \
  --matrix dsh-health-out/matrix/matrix.json \
  --limit 300 --out site
```

The command writes `site/index.json` (format `1`) plus `site/build-report.md`, then validates the
document with `@deepseek-ai/dsh-plugin-market-index` — the official reader used by the DSH Host.
Host the directory on any static origin (GitHub Pages is fine; no redirects) and paste the
`index.json` URL into **Plugins → 自定义插件市场 → 发现 → 添加索引源**.

Index facts:

- market title/description and every plugin title/description are localised (`en` required, `zh` kept);
- categories come from the catalog, plus labels (`npm`, `compatible`, `incompatible`,
  `unchecked`, `capability risk`) and sort keys (`downloads`, `stars`, health score);
- the health score is deterministic: popularity (log downloads 55, log stars 25) ± compatibility
  and capability-risk adjustments, 0–100;
- versions listed per plugin default to the dist-tag latest first, then the highest versions
  (`--max-versions`, default 3), with the npm publish timestamp and `engines.dsh`.

Current scope: npm-published catalog entries only (2,607 of 5,704 in the October 2026 snapshot).
GitHub/tarball-only entries are skipped and reported; git source support (commit-pinned) is on the
roadmap.

## 3. Windows/WSL doctor and repair

```sh
dsh-plugin-health doctor --home C:\Users\me\.dsh --profile desktop --runtime 0.2.1-rc.2
dsh-plugin-health repair --home C:\Users\me\.dsh --profile desktop --apply --yes
```

Checks: declared third-party bundles that are not installed (bundles shipped by the DSH
installation are treated as provided), unreadable/partial package directories, missing profile
dependencies, broken or empty `cordis.patch.yml` entries, `.bak-*` / `.lock` / `.lock.takeover-*`
residue, large plugin-manager logs, proxy configured without `NODE_USE_ENV_PROXY=1`, WSL and long
Windows paths, installed-plugin incompatibility against `--runtime`, and plugin-set drift between
profiles.

Repairs are opt-in (`--apply`), default to a dry run, and never delete:

- files/directories move to `<home>/.plugin-health/quarantine/<timestamp>/` (a `repair-log.json`
  records every action);
- `cordis.patch.yml` is edited textually (top-level `- []` entries only) after a backup, so comments
  and formatting survive.

## Roadmap

- runtime smoke: install and mount the plugin in an isolated profile per host version;
- git/tarball catalog entries with commit-pinned sources;
- matrix over the whole catalog, published nightly next to the index;
- a DSH plugin panel that renders the matrix and doctor results in-app;
- a reusable GitHub Action and a public compatibility dashboard.

## Development

```sh
npm ci
npm test
```

23 unit tests cover the official compatibility semantics, the format-1 builder (validated with the
official parser), and the doctor/repair flow on fixture homes. No network is needed for tests.

## Disclaimer

DSH plugins run with the user's full permission. A health score, a compatibility label, or a
catalog listing is not a security review. Third-party indexes are unsigned; only add sources you
trust.

## License

MIT
