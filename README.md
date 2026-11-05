# dsh-plugin-health

[![CI](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml/badge.svg)](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-health.svg)](https://www.npmjs.com/package/dsh-plugin-health)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](https://github.com/EasonMWS/dsh-plugin-health/blob/main/README.md) · [中文](https://github.com/EasonMWS/dsh-plugin-health/blob/main/docs/README.zh.md)

**DSH updated and your plugins stopped loading? This tells you which ones broke, which can be fixed,
and which cannot — then fixes them for you.**

Some rejected plugins have outdated version declarations. For trusted plugins, this tool can install
and boot them using a separate temporary DSH data directory before offering a version exemption,
a brief for your own AI, or a configuration change to disable the plugin.

**Health diagnoses compatibility and observed loading problems; it does not contain malware.**
Startup checks execute plugin code with your account permissions and cannot safely open unknown
software. Read [Health's security boundaries](SECURITY.md#malware-containment-is-not-implemented)
and the [official DSH safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md).

> Source candidate: `3.0.0-beta.4`. The registry install below follows the published npm release.

```sh
npm install -g dsh-plugin-health
```

**No terminal needed.** Install it, restart DSH, then open **Settings → Plugin health** and press the
buttons. The commands below are for people who prefer a shell.

**Not ready to install?** Check any plugin first, in the browser:
**<https://easonmws.github.io/dsh-plugin-health/compat/>** — every catalogued plugin against every
current host version, rebuilt daily.

---

## Contents

| If you are… | Read |
| --- | --- |
| a DSH user whose plugins broke | [Fix a broken plugin](#fix-a-broken-plugin) |
| stuck because DSH will not start | [When DSH will not start](#when-dsh-will-not-start-at-all) |
| a plugin author | [Compatibility checks in CI](#for-plugin-authors-checks-on-every-pull-request) |
| building a plugin market | [Use the plugin index](#use-the-plugin-index-as-a-data-source) |
| checking whether this tool is safe | [Security](#security) |

---

## Fix a broken plugin

When a plugin is rejected, a chip appears in the sidebar — no need to go looking:

![The sidebar chip showing two plugin issues with a View button](https://raw.githubusercontent.com/EasonMWS/dsh-plugin-health/main/docs/images/sidebar-alert.png)

Open **Settings → Plugin health**. You get one line per problem, and one button per plugin:

- **Check whether it can be saved** — installs and boots a trusted plugin in a separate temporary
  DSH data directory (30–60 s). Health does not yet write a version exemption to your normal profile;
  the executed plugin still has your account's access to files, network and processes.
- **If it boots** → *Exempt temporarily*. One entry is written to the host's own
  `compatibility.json`, with one-click undo.
- **If it does not boot** → no exemption button at all. Two honest choices:
  switch the plugin off, or take a prepared brief to your own AI.

You can revoke Health's exemption record. Revocation does not undo effects of plugin execution.

![The settings section: a mode selector, the capability boundary, live startup status, and a rejected plugin](https://raw.githubusercontent.com/EasonMWS/dsh-plugin-health/main/docs/images/settings-finding.png)

Once the rehearsal passes, you get the exemption and a Revoke button beside it:

![A temporary exemption in effect, with one click to revoke it](https://raw.githubusercontent.com/EasonMWS/dsh-plugin-health/main/docs/images/settings-exemption.png)

**Or check everything at once.** If you prefer a shell:

```
$ dsh-plugin-health doctor --profile desktop
scanned 19 plugins…
✓ 14 healthy
⚠ 3 have a stale version range (these can be saved)
✗ 2 are genuinely incompatible
```

## What "exempt temporarily" actually means

**The gate lets it through — that is not official support.** A passing trial records that startup
checks completed in the temporary DSH data directory. It does not certify plugin safety or all features.

- It writes DSH's own `allow-version` exemption. No plugin is modified, nothing on npm is touched.
- It applies to the host version you granted it for. After an upgrade, it needs re-checking.
- It is listed under "Temporary exemptions". Revoking it restores the recorded exemption value,
  not files, network activity or other effects produced by the plugin.
- Once the author ships a supported release, the panel tells you to revoke and upgrade.

## What happens between "rejected" and "fixed": four layers

Reading declarations is the first layer. Four things happen between a plugin being rejected and your
DSH working again:

| # | Layer | What it does | Where |
| --- | --- | --- | --- |
| **1** | **Detect** | Scans every installed plugin — bundles, `dependencies`, `cordis.patch.yml` inserts (including nested ones) and `node_modules` — and compares each declaration against the version you actually run | your machine |
| **2** | **Verify** | Rehearses a trusted plugin in a **separate temporary DSH data directory**: grants the exemption *there*, installs it, boots it, checks activation | current account; trial files retained |
| **3** | **Repair** | If the rehearsal booted, writes a single official `allow-version` exemption to *your* profile — recorded, one click to undo | your profile |
| **4** | **Escalate** | If the trial fails or is inconclusive, withholds the normal-profile exemption and offers a disable option or a brief for your own agent. Checks upstream for an existing report first | your choice |

**Layer 2 is the one that decides.** Without it, layer 3 would be a guess.

## Why that middle layer matters

An outdated version declaration does not tell us whether a plugin will boot. Measured on `0.2.1-rc.4`:

| Plugin | Declared | Observed startup in a temporary DSH data directory |
| --- | --- | --- |
| `@nanmicoder/dsh-agent-teams@0.1.27` | ❌ rejected | ✅ **full boot, all 94 entries active** |
| `dsh-find-plugin@0.4.0` | ❌ rejected | ✅ **runs fine** |
| `@feng0531/dsh-vcs@0.4.10` | ❌ rejected | ❌ **fails: waits for a service the host no longer provides** |

By declaration, all three are equally rejected. Two of them boot without complaint; one does not.
**Reading declarations cannot tell them apart, which is why the trial precedes the normal-profile
exemption.** Exempting the third would have produced exactly the outcome the gate exists to prevent — a
plugin that loads and then misbehaves, with no warning left anywhere.

## For plugin authors: checks on every pull request

**You do not need to install anything for this.** DSH ships a prerelease every week or two, and a
pinned `engines.dsh` breaks your plugin on a schedule. This Action tells you in the PR, before your
users find out.

Add one file, `.github/workflows/dsh-compat.yml`:

```yaml
name: dsh compatibility
on: [pull_request]
permissions:
  contents: read
  pull-requests: write      # required to post the comment
jobs:
  matrix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: EasonMWS/dsh-plugin-health@v1.2.0
        with:
          plugins: .
          versions: latest,next
```

That posts a comment on the PR with a compatibility table, writes a job summary, and uploads
`matrix.json`, `matrix.md` and SVG badges.

**Fail the build when your plugin breaks.** Add `failOn: any` and the job goes red instead of posting
a passing table. Better: watch only the channel you actually support, so a new nightly warns you
without blocking contributors:

```yaml
        with:
          plugins: .
          versions: latest,next,alpha
          failOn: next          # red on the next channel only
```

**Show the result in your README.** The run writes badges you can commit:

```markdown
![dsh compatibility](dsh-health-matrix/dsh-compat.svg)
```

This is the cheapest way to answer "does this still work on the current DSH?" — for you and for
anyone browsing your repo.

Prefer a reusable workflow? [`matrix-review.yml`](.github/workflows/matrix-review.yml) does the same
with less YAML:

```yaml
jobs:
  matrix:
    uses: EasonMWS/dsh-plugin-health/.github/workflows/matrix-review.yml@v1.2.0
    with:
      plugins: '.'
      versions: 'latest,next,alpha'
      comment: true
```

Full inputs: [`action.yml`](action.yml) · example: [`examples/dsh-compat.yml`](examples/dsh-compat.yml).

## The flow, in the order it happens

```
scan finds a rejected plugin
  ↓
trial in a temporary DSH data directory: exempt there, then boot trusted code
  ├─ it boots → standalone startup passed in this trial
  │    → confirm, then write one exemption in your profile (undo in one click)
  │    → record it and watch upstream for a real release
  │    → when a fix ships, the record tells you to revoke and upgrade
  └─ it fails or is inconclusive → report what this trial observed
       → do not write the normal-profile exemption
       → two choices: switch it off, or generate a brief for your own agent
```

The order avoids writing a normal-profile exemption before startup checks pass. It does not
constrain the tested code's access to your computer or make an unknown plugin safe to execute.

## What it looks like in Settings

Under **Settings → Plugin health**, every incompatible plugin gets:

- a **"Check whether it can be saved"** button — rehearses install + boot in a temporary DSH data
  directory (30–60 s), before writing a normal-profile exemption;
- **if it boots**: a confirmation step that restates exactly what will be written, that it is
  reversible, and that it is *not* official support — then the exemption;
- **if it does not boot**: no exemption button at all, plus the two honest options;
- every exemption listed with an undo button, flagged once upstream ships a fix.

An exemption is an entry in the host's own `compatibility.json`. Undo restores the recorded
exemption value. It does not reverse plugin side effects or guarantee that loaded code has stopped.

### Three controls in the header

| Control | What it does |
| --- | --- |
| **Rescan** | Re-runs the whole check now |
| **Check for updates** | Asks npm whether *this plugin* is current, on demand |
| **Browse all plugin health** | Opens the [public compatibility table](https://easonmws.github.io/dsh-plugin-health/compat/) in your browser |

**An update installs from the panel — one button, no terminal.** Checking ends in **Update now**,
which runs the profile's own package manager (pnpm in a pnpm profile, never npm into it) against the
exact version the check found. It says it needs a restart rather than performing one: the files change
on disk, the running host keeps the code it loaded, and restarting on your behalf would end your
session without asking. A failure shows the package manager's own message, not an exit code.

**It checks for its own updates when DSH starts, and stays quiet about it.** A health tool that is
itself out of date is worse than useless — it tells you your plugins need attention while missing the
fix released for the checker. One request per launch, at most one every six hours, and it only speaks
up when something newer exists, with the exact upgrade command. An "up to date" banner on every visit
would train you to ignore the strip where a real notice has to appear.

A check that fails is recorded as a failure, never as "you are current": those are different
statements and only one of them is true.

**No outbound traffic from a health tool?** Set `DSH_PLUGIN_HEALTH_NO_UPDATE=1` and it makes no
update requests at all. The panel's **Check for updates** button still works — that one is you asking.

## Check compatibility in a browser

Before installing anything:

**<https://easonmws.github.io/dsh-plugin-health/compat/>**

Every plugin in the community catalog, checked against the current host versions, with the counts at
the top so you can see the state of the ecosystem at a glance:

| | |
| --- | --- |
| **How many** | Total checked, how many load on every host, how many a host rejects |
| **Category** | The catalog's own category, filterable |
| **Released** | Publish date of the version shown — tells you whether the author is still active |
| **Filter** | By name, by category, or only the rejected ones |
| **Language** | English / 中文, remembered between visits |

A tick means the plugin's declared range admits that host, so the installer will not reject it. It
does **not** mean the plugin works, and it is not a security review. The page says which plugins it
covers and which it cannot: GitHub-only and tarball-only entries are not on npm and are not checked.

The same data is downloadable as
[`matrix.json`](https://easonmws.github.io/dsh-plugin-health/compat/matrix.json), and you can build
the page for your own plugin set:

```sh
dsh-plugin-health matrix --plugins list.txt \
  --versions latest,next \
  --catalog https://awesome-dsh-plugin.com/plugins.json \
  --out site/compat
```

## Use the plugin index as a data source

If you are building a plugin market, a directory, or a launcher, there is a ready format-1 index:

```
https://easonmws.github.io/dsh-plugin-health/index.json
```

**Use it in DSH right now:** paste that URL into **Plugins → 自定义插件市场 → 发现 → 添加索引源**.

- **format-1** — the DSH official market index format, validated on every build with
  `@deepseek-ai/dsh-plugin-market-index` (the same reader the DSH host uses)
- **300 plugins**, rebuilt daily at 04:23 UTC
- per plugin: name, description (en + zh), author, repository, homepage, category, download count,
  GitHub stars, a heuristic health score, and the recent version history
- source: [`awesome-dsh-plugin.com/plugins.json`](https://awesome-dsh-plugin.com/plugins.json)

Build your own with:

```sh
dsh-plugin-health index \
  --catalog https://awesome-dsh-plugin.com/plugins.json \
  --host "$(npm view @deepseek-ai/dsh version)" \
  --index-url https://example.com/index.json \
  --limit 300 --out site
```

Details: descriptions are bilingual (`en` required, `zh` kept); categories come from the catalog plus
labels (`npm`, `compatible`, `incompatible`, `unchecked`, `capability risk`) and sort keys
(`downloads`, `stars`, health score). The health score is deterministic — popularity (log downloads
55, log stars 25) adjusted for compatibility and capability risk, 0–100. **It is not a security
rating.** Download counts and stars come from public npm and GitHub data.

Scope: npm-published catalog entries only (2,607 of 5,704 in the October 2026 snapshot); GitHub- and
tarball-only entries are skipped and reported.

## Security

**Running anything below 2.1.3? Upgrade.** Three rounds of review fixed these, and one release fixed
problems the previous one had only half-fixed — so the version matters:

| Version | What it fixed |
| --- | --- |
| **1.1.0** | Seven issues from a security test of 1.0.2, one rated high: the write routes' control key was handed out by the unauthenticated status endpoint |
| **2.0.0** | 25 findings from two more reviews. A cross-origin page could drive every write route (cookies ignore the port, so same-site is not same-origin); a request body could name any package to install and run; three paths granted an exemption without a rehearsal on the target host |
| **2.1.1** | Four fixes from the previous release that did not hold. The worst: the loopback check read only the `Host` header, which the client writes — so with the web server bound to a LAN address, any machine on the network could send `Host: 127.0.0.1:<port>`, pass every check, read the key from `/status`, and disable plugins |
| **2.1.3** | The panel could not obtain its key, so every button answered 401; the message also blamed the network for what was an authentication failure |

**If you bind the DSH web server to a non-loopback address** (`0.0.0.0` or a LAN IP), treat every
plugin route as exposed to the network and check that the host's own authentication is what you are
relying on.

- [GHSA-vj8q-543v-9hw5](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-vj8q-543v-9hw5) — 1.1.0
- [GHSA-52w2-cq6j-xhg7](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-52w2-cq6j-xhg7) — 2.0.0
- [SECURITY.md](SECURITY.md) — the trust boundary, in full

**Trust boundary, stated plainly:** the write routes are reachable by any local process. The loopback
interface is the boundary — not the control key. A local process can read `Set-Cookie` and replay it;
what the key does stop is a page on another local port, and that is what the peer and same-origin
checks enforce.

## Safety boundaries (please read)

> **Security:** see [Security](#security) above for the full version table. The short version: below
> 2.1.3 you are missing at least one fix that matters, and the loopback check before 2.1.1 could be
> bypassed by a LAN client with a forged `Host` header.

| Health's actions | What Health itself does not do |
| --- | --- |
| Rehearse trusted code using a temporary DSH data directory | ❌ call your AI or spend your tokens |
| Use DSH's official `allow-version` exemption | ❌ modify plugin source or anything on npm |
| Record version exemptions and support revoking them | ❌ grant an exemption when the rehearsal failed |
| Check whether upstream already has a report | ❌ file issues on your behalf |
| Prepare a complete AI brief | ❌ press send for you |

These statements describe Health's own actions. Code executed during a trial has the account's
permissions and is outside these guarantees. A failed trial can already have produced side effects.
Health's repair quarantine is an ordinary backup directory, not antivirus isolation.

**A temporary exemption allows loading on the selected host version.** The trial covers observed
startup checks, not malicious behavior or all features. When the author ships a supported version,
revoke the exemption and upgrade. Revoking permission does not undo plugin effects.

## What 3.x promises

A major version is a promise about stability, so here is exactly what is frozen and what is not —
rather than letting you find out by upgrading.

2.0.0 broke three things on purpose, and they are listed in the changelog: writes need
`application/json`, the rescue actions refuse plugins that are not installed, and a
`compatibility.json` that cannot be parsed is refused rather than rewritten. Everything below has
held since 1.0 and still holds.

**Frozen** for 3.x:

| Surface | Guarantee |
| --- | --- |
| CLI commands and flags (`matrix`, `smoke`, `doctor`, `repair`, `rescue`, `handoff`, `report`, `boot`, `index`) | Existing flags keep their meaning. New flags may be added; none are removed or repurposed |
| The `plugin_health` agent tool's name and input schema | Additive fields only |
| Exit codes (`0` success, `1` findings/failure, `2` usage error) | Unchanged |
| Files this tool writes (`compatibility.json`, `plugin-health-rescue.json`, handoff bundles) | Format documented and forward-compatible: unknown keys are preserved, never dropped |
| The status route shape (`/plugins/dsh-plugin-health/status`) | Fields may be added; existing fields keep their names and types. Since 2.1.3 the body also carries `key`, the per-launch control key the panel uses to authenticate its own writes — see [Security](#security) for why that is not a weaker boundary than the cookie |

**Not frozen** — may change in a minor release, because they are presentation or internals:

- UI wording, layout, colours and the structure of the settings panel;
- the recommendation text inside generated AI briefs and issue drafts;
- internal module layout under `src/` (nothing in `src/` is a public import path except
  `./api` and `./client`);
- the set of finding ids beyond the documented ones — new checks will introduce new ids.

**Version policy for a host bump.** `engines.dsh` is a range (`>=0.1.0-rc.6 <0.3.0-0`), not an
enumeration, so a new DSH nightly does not break this plugin the way it breaks plugins that pin
exact versions. When DSH 0.3.0 ships, this package needs a release that extends that range — the one
known expiry point, announced in the changelog before it lands.

## When DSH will not start at all

If a plugin stops DSH from booting, the settings page cannot help — it runs inside DSH. These three
commands run **entirely outside the host**, so they still work from a terminal:

```sh
# 1. Why did it fail? Reads the host's own crash reports, then static checks.
dsh-plugin-health boot diagnose --profile desktop

# 2. Cannot tell? Disable every third-party entry so DSH starts again.
dsh-plugin-health boot safe --profile desktop --apply

# 3. Once the culprit is fixed, put everything back.
dsh-plugin-health boot restore --profile desktop --apply
```

`boot diagnose` reads the desktop app's crash reports
(`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`), which name the offending package outright
when a plugin is at fault — the CLI itself prints to stderr and leaves nothing on disk.

`boot safe` only appends `disabled: true` overlays to the profile's own patch layer: **no files are
deleted, no plugin is modified, host entries are never touched, and this tool never disables
itself** (that would remove the panel explaining what happened). `boot restore` removes only the
entries it added, leaving your own patches exactly as they were. Both default to a dry run; add
`--apply` to write.

## Looking for a plugin manager / doctor / checker?

This package is what you want if you are searching for any of these:

| If you are looking for… | This package does that |
| --- | --- |
| a **plugin manager** for DSH | shows every installed plugin and its state in one page |
| a **plugin checker / inspector / scanner** | scans all installed plugins, not a sample |
| a **plugin doctor** / diagnostics | explains what is broken and what to do about it |
| Plugin upgrade and conflict review | checks declared DSH ranges, literal patch overrides and declared shared writes |
| to **fix / repair a broken plugin** | one-click repair (quarantine only, never deletes) |
| why a plugin **stopped working after a DSH update** | compares declared ranges against the new host |
| 插件管理 / 插件检查 / 插件冲突 / 插件诊断 / 插件不兼容 | 中文界面，设置 → 插件健康 |

Not this package if you want to *browse and install new plugins from a market* — that is a
marketplace, while this one manages what you already have. (It does build the official format-1
index that marketplaces can consume.)

## Why this exists: DSH gates installs, but not upgrades

DSH rejects a *new* install whose declared range does not cover the running version — that part is
solid:

```
$ dsh plugin --profile test add dsh-session-recall
dsh: installation rejected: Plugin dsh-session-recall@0.7.9 is incompatible with dsh 0.2.1-rc.3
dsh: nothing was installed.
```

What it does **not** do is re-check plugins that are already installed after the host moves. A
plugin declaring `engines.dsh: 0.2.1-rc.2` stays in `bundles` and keeps loading on `0.2.1-rc.3` with
no warning anywhere in the UI. That is the gap this package fills: it reads what every installed
plugin declares and compares it against the version you are actually running.

## It has already caught real regressions

Scanning the top 120 plugins across a host bump found 5 that load on `0.2.1-rc.2` but are rejected
on `0.2.1-rc.3`. Reports were filed for each, and maintainers acted — **4 of the 5 have shipped
fixes** (verified 2026-10-26), and the count of affected plugins went **5 → 1**:

> Confirmed against the published 0.1.47 manifest and the official rc.3 host compatibility
> evaluator: **19 DSH peers were rejected**, while rc.2 still passed.
> Fixed on main in #179 … All nine PR CI jobs passed, including the **new required rc.3 Profile
> lane**.
>
> — [Anionex/dsh-vision-toolkit#178](https://github.com/Anionex/dsh-vision-toolkit/issues/178#issuecomment-6388178989)
> (906★), on a fix prompted by this scan — released as `0.1.48`

| Plugin | Fixed in | Status |
| --- | --- | --- |
| `@anionex/dsh-vision-toolkit` | `0.1.48` | ✅ released, verified on rc.2 + rc.3 |
| `dsh-plugin-subscriptions` | `0.9.11` | ✅ released, verified on rc.2 + rc.3 |
| `@nanmicoder/dsh-agent-teams` | `0.1.27` | ✅ released, verified on rc.2 + rc.3 |
| `@goodandready/dsh-clinebot` | `0.6.16` | ✅ released, verified on rc.2 + rc.3 |
| `dsh-workbuddy-connect` | — | ⚠️ still `0.7.9` (repository unreachable — the one case where no report could even be filed) |

Full report: [docs/upgrade-0.2.1-rc3.md](docs/upgrade-0.2.1-rc3.md).

## A real UI, only when you need it

Install it as a bundle and DSH gets a native **Settings → Plugin health** section
(**设置 → 插件健康** in Chinese). The panel and sidebar alert follow DSH's language setting,
including finding details and repair confirmations.

```sh
dsh plugin --profile desktop add dsh-plugin-health
#                 ^^^^^^^ desktop app uses `desktop`; `dsh web` uses `web`
```

- **It checks every plugin you actually have installed**, not a sample and not just the bundle list:
  bundles, `package.json` dependencies, `cordis.patch.yml` inserts (including nested ones), and
  anything plugin-shaped in `node_modules`. The header tells you how many were inspected.
- Every finding is written in plain language with a concrete next step — a first-time user can act
  without reading CLI docs.
- One line at the top says whether you can relax (`可以放心用`) or should act (`有问题建议处理`),
  with three controls beside it: `重新扫描` to re-run the check, `检查更新` to ask the registry
  whether this plugin itself is current, and `浏览全部插件健康状况` to open the
  [public compatibility table](https://easonmws.github.io/dsh-plugin-health/compat/).
- **It checks for its own updates when DSH opens** and only speaks up when there is something newer,
  with the exact upgrade command. No "you are up to date" banner on every visit.
- **If nothing is wrong, nothing is shown.** The plugin adds no badge, no banner, no sidebar entry.
- **When something is wrong**, a compact `插件有 N 个问题` entry appears above the account menu and
  jumps straight to the section.
- The host half only serves a loopback-only read-only snapshot; the plugin never modifies your
  profile.

> **Upgrading DSH? Run the check first.**
>
> `0.2.1-rc.3` (2026-10-23) dropped the compatible count from 118 to **113 of the top 120** plugins:
> **5 plugins that worked on rc.2 stop loading on rc.3**, all because they enumerate exact
> `@deepseek-ai/*` versions. As of 2026-10-26, **4 of them have shipped fixes** (affected 5 → 1).
> Earlier, rc.2 had broken 3 others. Latest report:
> [docs/upgrade-0.2.1-rc3.md](docs/upgrade-0.2.1-rc3.md) ·
> [docs/upgrade-0.2.1.md](docs/upgrade-0.2.1.md).
>
> ```sh
> dsh-plugin-health matrix --plugins plugins.txt --versions 0.2.1-rc.2,0.2.1-rc.3
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
dsh plugin --profile desktop add dsh-plugin-health
#                 ^^^^^^^ desktop app uses `desktop`; `dsh web` uses `web`
```

The bundle declares `engines.dsh` and registers this read-only tool alongside the settings UI.
Profile changes use the UI's explicit repair and exemption controls; startup can also check for
Health updates as described above.

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

The matrix is **static** (manifests + official requirements). A passing declaration does not
prove that a plugin activates or that its tools work. Use the separate opt-in `smoke` command
below for runtime acceptance. Git-only plugins can be checked statically from a local clone.

### Runtime acceptance in a fresh profile

Install the host version you want to test into a separate directory, then test the package users
will install, including a release tarball:

```sh
npm install --prefix /tmp/dsh-rc3 @deepseek-ai/dsh@0.2.1-rc.3
dsh-plugin-health smoke \
  --dsh-dir /tmp/dsh-rc3/node_modules/@deepseek-ai/dsh \
  --plugin ./my-plugin-1.0.0.tgz \
  --tool my_plugin_tool \
  --calls ./smoke-calls.json \
  --out dsh-health-out/runtime
```

`smoke-calls.json` is an array of tool calls. Each call must complete without a tool error;
`expectedValue`, when provided, is compared with the entire structured return value:

```json
[{"name":"my_plugin_tool","arguments":{"input":"example"},"expectedValue":{"answer":42}}]
```

The command installs through the official `dsh plugin` CLI into a new `DSH_HOME`, boots through
the host's public `@deepseek-ai/dsh/profile-boot` export, checks named tool registrations, executes
the supplied calls, and disposes the profile. It requires at least one `--tool` or `--calls`
assertion. `--tool` alone checks registration, not tool behavior or browser rendering.

Installation has a 120-second limit. Boot, calls and shutdown share a 30-second limit; override
with `--install-timeout` and `--timeout` (milliseconds). On timeout, Health attempts to stop the
trial's child process tree; cleanup is best effort. The report names the failing
stage (`install`, `boot`, `assertions` or `shutdown`) and preserves the host diagnostic. Exit 1
means acceptance failed, even if a signal handler exits zero after a timeout.
On POSIX, a process that exits zero but leaves background descendants also fails acceptance and
its remaining process group is stopped. Windows uses `taskkill /T` for timeouts; detecting children
after their parent has already exited is not supported there.

Every run retains its home, `smoke.json`, `runtime.json` and bounded stdout/stderr in a new run
directory. Health selects that new directory as the trial's profile; it does not prevent the tested
code from accessing existing profiles. There is no automatic cleanup; inspect logs before sharing
them. Repeat with a separate installed host directory for each version in your matrix.
The installed host needs Node.js and pnpm versions supported by that DSH release, and must export
`profile-boot` (tested with `0.2.1-rc.2` and `0.2.1-rc.3`).

**This runs plugin code with your OS account permissions and inherited environment.** A temporary
DSH home selects separate test data; it does not restrict file, network or process access. Only run
packages you trust. Unknown software needs a separately configured environment that restricts files,
credentials, networking and processes; Health does not create or verify that environment. Startup
checks cannot certify all plugin behavior, safety or UI compatibility.

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

## 2. Windows/WSL doctor and repair

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

## Review your profile before making changes

Open **Settings → Plugin health** and choose a view. **Daily check** suits occasional users who want
problem summaries and recovery controls. **Advanced diagnostics** suits frequent users managing
several plugins, adding loader entries, recent transitions, configuration findings and target-version
preview. **Developer verification** suits plugin authors, adding runtime evidence export and CLI examples.

These are display preferences, not different protection levels. Permissions and scan coverage are
the same in all three views. Preview inputs, results and
expanded sections remain when switching views in the open panel. Disclosures support Enter and Space,
respect reduced-motion preferences and wrap on narrow screens. The panel reads host state every 30
seconds. A failed refresh preserves the last results with a stale notice, and a later configuration
change prompts a new preview. Review exported plugin names, configuration identifiers and paths before sharing.
Read requests time out after 15 seconds and allow retry. Repair confirmation uses a one-use preview
valid for five minutes. New or changed targets require another preview; failed repairs show their reason
and offer a fresh plan before confirmation.

`scripts/browser-qa.mjs` exercises the real React component in Edge using synthetic host responses,
including three views, keyboard interaction, transitions, downloads, 360px layouts and dark appearance.
Its setup instructions keep test dependencies outside the package. Native DSH desktop acceptance is separate.

The status endpoint samples the current loader as the panel or sidebar refreshes. It records the last
24 observed transitions in memory for this host session. If the host retains a recognized duplicate-tool
error, the panel shows the tool name and the rejected entry. This is a sampled view of activation.
Tool execution, file writes and network access require a separate test.

The downloadable snapshot can be compared from a terminal, including when DSH cannot start.

```sh
dsh-plugin-health review --profile desktop --runtime 0.2.1-rc.5 --save before.json
dsh-plugin-health review --profile desktop --target 0.2.1-rc.6 --candidate ./unpacked-plugin --json
dsh-plugin-health review --profile desktop --runtime 0.2.1-rc.6 --compare before.json
```

The candidate command reads an unpacked local package without installing or starting it. It models
the bundle's declared patch in the current order, or at the end of the bundle list for a new install.
The report separates declarations from loader state. It identifies repeated literal insert IDs,
configuration keys omitted by later rows and selected core package copies inside the profile.
It leaves dynamic patch rows, launcher overlays and actual tool or file behavior unverified.
The snapshot stores package metadata and file fingerprints. It is a comparison baseline, and repair
backups are stored separately. Exit status 1 indicates a known declaration mismatch or a command error.
For CI, retain the JSON report alongside the existing runtime acceptance checks.

To test trusted packages together, repeat `--with <name@version|unpacked-dir>` on a
`smoke --dsh-dir <dir> --plugin <name@version|unpacked-dir>` command with `--boot-only` or
your existing tool assertions. The trial installs the selected packages in one temporary profile,
checks that each enters the loader, and records each install separately. The same OS permission
boundary as the single-plugin trial applies.

Plugin authors can optionally declare exact file access in `package.json`:

```json
{
  "dshPluginHealth": {
    "version": 1,
    "resources": [
      { "scope": "workspace", "path": "archive/index.json", "access": "write" }
    ]
  }
}
```

Scopes are `workspace`, `profile` and `dsh-home`. Entries are relative file names with `read` or `write`
access. Review flags multiple declared writers to the same scoped file, including a local candidate.
This is evidence of declared intent and requires cooperation from plugin authors.

For new repairs using the default quarantine, the repair output includes a run ID.
`dsh-plugin-health repair --restore <run-id>` previews recovery. Add `--apply --yes` to restore
eligible items. Recovery refuses to overwrite an occupied quarantine destination or a patch edited
after repair. Start DSH afterward to verify the affected behavior.

## Roadmap

- runtime acceptance for browser-only plugins (the current smoke command probes agent tools);
- git/tarball catalog entries with commit-pinned sources;
- matrix over the whole catalog, published nightly next to the index;
- a DSH plugin panel that renders the matrix and doctor results in-app;
- a reusable GitHub Action and a public compatibility dashboard.

## Development

```sh
npm ci
npm test
```

Unit tests cover the official compatibility semantics, the format-1 builder (validated with the
official parser), doctor/repair fixtures, and runtime-runner failure paths. `npm test` needs no
network. To run the separate installed-host acceptance fixtures (requires pnpm and an installed
host):

```sh
npm run test:runtime -- /tmp/dsh-rc3/node_modules/@deepseek-ai/dsh
```

This packs and installs controlled healthy, pending-injection, throwing-init and hanging-init
fixtures. Their profiles and reports are retained for inspection.

## Disclaimer

DSH plugins run with the user's full permission. A health score, a compatibility label, or a
catalog listing is not a security review. Third-party indexes are unsigned; only add sources you
trust.

## License

MIT
