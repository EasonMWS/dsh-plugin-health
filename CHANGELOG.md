# Changelog

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
