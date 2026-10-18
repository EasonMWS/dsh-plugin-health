# Changelog

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
