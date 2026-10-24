# Changelog

## 0.4.2 (2026-10-24)

### Changed

- **Discoverability.** A user (or an AI agent acting for them) searching for "dsh plugin manager",
  "dsh plugin doctor", "plugin checker" or "插件冲突" previously could not find this package: npm
  search ranked it first only for its exact name. The description now leads with the words people
  actually use, `keywords` grew from 13 to 38 covering manager/doctor/checker/conflict/scan plus
  Chinese terms, and both READMEs open with a "looking for a plugin manager / doctor / checker?"
  table that states plainly what this package is and is *not*.
- The `plugin_health` tool description now names the situations that should trigger it (a plugin
  stopped working after an update, plugins appear to conflict, the user asks to check or manage
  plugins), so an agent can match a user's wording to the tool instead of guessing from its name.

## 0.4.1 (2026-10-24)

### Changed

- **The settings section now leads with a verdict, not a list.** A single line says whether you can
  relax (`可以放心用`) or should act (`有问题建议处理`), followed by the exact number of plugins that
  were inspected — so "clean" is backed by a visible count instead of a bare green box.
- **`重新扫描` button**: re-runs the check on demand instead of waiting for the 30 s poll.
- Copy rewritten for a first-time user: the subtitle now states plainly that every installed plugin
  is checked and that the check is read-only.
- The empty state repeats the inspected count, so a clean result is auditable.
- Footer demoted to secondary detail (last check time, DSH version, profile, home).

## 0.4.0 (2026-10-24)

### Fixed

- **The health check now scans every plugin installed in the profile, not just `dsh.profile.bundles`.**
  A profile can also pull plugins in through `cordis.patch.yml` insert entries and through plain
  `node_modules` entries, and those were silently skipped — a profile could report "clean" while an
  incompatible plugin sat right beside the scanned ones. On this machine the desktop profile went
  from 9 checked packages to 15.
- Host packages (`@deepseek-ai/*`) are excluded from the compatibility check; they *are* the
  reference the plugins are checked against.

### Added

- `listInstalledPlugins()` is exported and covered by 5 tests (bundles, patch inserts, nested
  inserts, orphan `node_modules` entries, de-duplication, malformed patch file).

## 0.3.5 (2026-10-24)

### Added

- `docs/upgrade-0.2.1-rc3.md`: a scan of the top 120 plugins comparing `0.2.1-rc.2` → `0.2.1-rc.3`.
  **rc.3 drops the compatible count from 118 to 113** — 5 plugins that load on rc.2 are rejected on
  rc.3, all because they enumerate exact `@deepseek-ai/*` versions.
- README now leads with the rc.3 numbers instead of the older rc.2 scan.

### Fixed

- Ship the two upgrade reports in the npm package so the README links resolve on npmjs.com.

## 0.3.0 (2026-10-21)

### Added

- **One-click repair in the settings UI.** Findings the host marks auto-fixable now get a
  `一键修复 N 项` button. It always shows a dry-run plan first, then applies only after an explicit
  confirm; the result lists exactly what moved and where it can be restored from.
- Baseline repair still never deletes: files move to `~/.dsh/.plugin-health/quarantine/<timestamp>`
  and a `repair-log.json` records every action.

### Fixed

- The UI now inspects the **running** profile (`ctx.profileContext`) instead of assuming `desktop`,
  so a plugin installed into `web`/`tui`/custom profiles reports that profile's findings.
- The status cache is invalidated after a repair, so the section refreshes immediately instead of
  showing stale results for a few seconds.

## 0.2.0 (2026-10-21)

### Added

- **Visual UI inside DSH.** The package is now a dual-half bundle: the host half serves a
  loopback-only read-only snapshot at `/plugins/dsh-plugin-health/status`, and the browser half
  registers a native **Settings → 插件健康** section. Findings are written in plain language with a
  concrete next step, so a first-time user can act without reading the CLI docs.
- **Sidebar alert that only exists when something is wrong.** When the snapshot has an actionable
  finding, a compact `插件有 N 个问题` entry appears above the account menu and jumps straight to the
  settings section. With no findings the plugin shows nothing at all.
- 6 new tests for the status route (loopback guard, method guard, snapshot shape, missing home).

## 0.1.6 (2026-10-18)

### Added

- `docs/upgrade-0.2.1.md`: real upgrade report over the top 120 ecosystem plugins, comparing
  `0.2.0-rc.2` with `0.2.1-rc.2` (3 plugins regress, 11 are fixed, 1 stays broken).

### Changed

- README, package description and keywords now lead with the upgrade check and the reusable
  GitHub Action so users can find the tool from the problem they are hitting.

## 0.1.5 (2026-10-18)

### Fixed

- CLI: `--plugins .` and other local directories are treated as plugin specs instead of being read
  as list files (`EISDIR`), so the GitHub Action can evaluate the checked-out plugin repository.
- Reusable workflow: install the CLI into a temporary npm prefix and call its binary directly,
  avoiding `npx`/`npm exec` resolution differences on GitHub-hosted runners.

## 0.1.4 (2026-10-18)

### Fixed

- Ship `bin` scripts with LF shebangs. The release now packs from the LF checkout used by GitHub
  Actions, fixing `dsh-plugin-health: not found` on Linux for packages packed on Windows.
- Reusable workflow: declare `workflow_call` input types and use camelCase input names so GitHub
  accepts the workflow file.
- Reusable workflow: invoke the CLI through `npm exec --package` so the binary resolves reliably on
  GitHub-hosted runners.

## 0.1.3 (2026-10-18)

### Added

- Reusable GitHub Actions workflow `matrix-review.yml`: runs the compatibility matrix for a plugin
  pull request, writes the job summary, uploads the matrix artifact, and creates or updates a pull
  request comment.
- `examples/dsh-compat.yml` caller template for plugin authors.
- Self-matrix workflow so this repository checks its own bundle on every pull request.

## 0.1.2 (2026-10-17)

### Changed

- First release published by GitHub Actions through npm Trusted Publishing (OIDC), with a
  provenance attestation. No functional changes.

## 0.1.1 (2026-10-17)

### Added

- Installable DSH bundle: `package.json` now declares `dsh.bundle` with `cordis.patch.yml`, so
  `dsh plugin --profile web add dsh-plugin-health` mounts the package as a plugin.
- Read-only `plugin_health` agent tool that reports missing third-party bundles, broken package
  directories, patch residue, proxy/registry configuration, profile drift, and installed-plugin
  incompatibility with the running DSH version.
- `./api` package export keeps the library API available now that `.` resolves to the bundle
  entry.

## 0.1.0 (2026-10-17)

Initial MVP.

### Added

- `dsh-plugin-health matrix`: evaluate plugins against multiple DSH host versions with the official
  compatibility semantics (`engines.dsh` first, otherwise `@deepseek-ai/dsh*` peers, prereleases
  included, `workspace:` ranges mapped to the host). Markdown report, JSON, static SVG badges, and
  a `--fail-on` CI gate.
- `dsh-plugin-health index`: build a market index in official format 1 from an awesome-dsh-plugin
  snapshot, with localised titles/descriptions, catalog categories, `npm` / compatibility /
  capability-risk labels, downloads/stars/health sort keys, and official-parser validation.
- `dsh-plugin-health doctor` / `repair`: Windows/WSL install diagnostics (missing third-party
  bundles, partial package directories, patch residue, stale locks, proxy environment, profile
  drift, installed-plugin compatibility) with dry-run-by-default, quarantine-only repairs.
- CI for Linux and Windows on Node 20/22, a nightly matrix workflow, a GitHub Pages index workflow,
  and a composite GitHub Action.
- English and Chinese READMEs, MIT license, security policy.
