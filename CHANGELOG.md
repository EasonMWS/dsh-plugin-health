# Changelog

## 1.1.0 (2026-10-31)

Security release. Seven issues found in a security test of 1.0.2, all reproduced and fixed,
each with a regression test.

### Fixed — the control key was handed to anyone who asked

- **/status returned the control key in its body.** The key existed to stop local processes from
  calling the write routes, but the unauthenticated status route handed it out, so it protected
  nothing. The key is now delivered as an `HttpOnly; SameSite=Strict` cookie: page scripts cannot
  read it, and it does not ride a cross-site request. The remaining trust boundary is the loopback
  interface, which is now stated in the code instead of papered over.

### Fixed — destructive actions on a configuration the tool did not understand

- **A patch layer that was not a YAML sequence was silently treated as empty**, and the next write
  replaced the file with only this tool's overlay — wiping every entry the user had. It is now
  refused with `PATCH_NOT_SEQUENCE`.
- **The patch layer was written in place with no backup.** Writes now keep
  `cordis.patch.yml.bak-plugin-health` and replace the file atomically via a temporary rename.

### Fixed — request input that reached the filesystem or a shell

- **Path traversal through the plugin version.** `handoff` filtered the package name but joined
  the raw `version` into a path, so `version: "../../../evil"` escaped the profile directory —
  a write primitive that could become execution via an autostart location. Both fields are now
  sanitised and the resolved path is proven to stay under the handoff root.
- **Command injection on Windows.** `prepareRehearsalHost` ran `npm` with `shell: true` and
  interpolated the version into the argument string. The install now runs without a shell, with
  `--ignore-scripts`, and only after the version is validated as exact semver — which also closes
  the `npm:evil` alias path, since the spec can no longer name another package.

### Fixed — caller-supplied directories and information leaks

- **`body.dshDirectory` chose which `bin` script got executed**, so dropping a folder anywhere
  on disk was enough for code execution. The value is now a hint that must resolve inside the
  profile, the DSH home, or this tool's host cache.
- **The rescue route compared the key non-constant-time**, and answered `404` for an unknown
  action before authenticating, which let an unauthenticated caller enumerate action names. Both
  are fixed: constant-time comparison, and authentication runs first.

### Changed

- The browser half no longer receives or sends the key at all; it relies on the cookie.

176 tests (12 new security regressions), 176 pass, 1 platform skip.

## 1.0.3 (2026-10-31)

### Fixed

- **The sidebar chip kept showing a count that was no longer true.** Reported from a real screen:
  the chip said "1 issue" while the panel itself listed none. Two defects stacked. The count was
  captured in the slot's `inject` at registration time, so it never updated; and the refresh
  returned early whenever the alert already existed, so a chip was never removed once the problem
  cleared. The count now lives in a variable the registration reads, and the alert is torn down and
  rebuilt when the number changes — the slot has no other way to update its props.

  A regression test drives a warning snapshot, then a clean one, and asserts the chip disappears;
  it fails against the previous code.

164 tests (1 new), 164 pass, 1 platform skip.

## 1.0.2 (2026-10-31)

### Fixed

- **The sidebar alert's button did nothing.** Reported by a user, not caught by any test. The alert
  called `layout.selectPanel('settings')` inside an empty `catch`. `selectPanel` only accepts
  keys registered in the host's `main` panel registry — `conversation`, `plugins`,
  `schedules` — and *throws* for anything else; the settings surface is a modal owned by the
  shell, not a main panel. The throw was swallowed, so the button was silently dead.

  It now dispatches the shell's own `settings.open` command (`Ctrl/Cmd+,` on desktop,
  `Ctrl+Alt+,` on web) and falls back to clicking the shell's settings control. If neither
  lands, the failure is visible instead of silent — a button that does nothing is worse than one
  that says why.

  A regression test pins the working path: it asserts the alert dispatches a Comma key event with a
  primary modifier, and would fail if the code went back to `selectPanel`.

163 tests + 1 new, 163 pass, 1 platform skip.

## 1.0.1 (2026-10-30)

### Fixed

- **`report` now carries a value the maintainer can paste.** The previous version printed the
  declared range back unchanged with a comment, which names the problem but not the edit — a report
  nobody can act on. It now works the suggestion out from what the package declares: an enumeration
  of one line becomes `>=0.2.1-0 <0.2.2-0`; an enumeration spanning several lines keeps that
  history and opens only the newest; a range that already covers the host is reported as needing no
  change. The ceiling stops at the next host line, never at the next major, so a future `0.2.2` is
  not silently admitted on the author's behalf.
- **`report` runs the rehearsal by default.** A verdict is the difference between "your ranges are
  stale" and "your ranges are stale and the code does load" — the second is what gets a fix merged.
  Users no longer have to run the rehearsal separately and remember to pass its result.

163 tests (8 new), 162 pass, 1 platform skip.

## 1.0.0 (2026-10-29)

First stable release. The four-layer flow — detect, verify, repair, escalate — is complete and
verified end to end against a real DSH host, including the failure paths.

### What 1.0 freezes

CLI commands and flags, the `plugin_health` tool contract, exit codes, the file formats this tool
writes, and the status-route shape. Anything under `src/` except the `./api` and `./client`
exports stays internal. UI wording and layout are deliberately *not* frozen. The full statement is
in both READMEs under "What 1.0 promises".

### Verified before release

Each layer was driven through the real settings page in a live DSH, not only by unit test:

- **detect** — the panel lists an incompatible plugin with its declared requirements;
- **verify** — a rehearsal returns `boots` for `dsh-find-plugin@0.4.0` and `fails` for
  `@feng0531/dsh-vcs@0.4.10` on the same host, which is the distinction a static checker cannot make;
- **repair** — the exemption is written, the warning disappears from the panel, and the record
  appears with an undo button;
- **escalate** — the AI brief is generated and the upstream check runs, with no exemption offered
  for the plugin that could not boot.

### Fixed during that verification

The end-to-end pass found four defects that unit tests had missed:

- **A desktop install has no on-disk host**, so every rehearsal failed with "no installed
  @deepseek-ai/dsh". The rehearsal now downloads its own host copy once, into this tool's own
  directory, used only for throwaway homes.
- **That download used npm's `latest` rather than the running version**, so the verdict described
  a host the user was not running. The version now comes from the live host, and the downloaded copy
  matches it.
- **The confirmation step could land below the fold**, hiding the button it was asking the user to
  press. It now scrolls itself into view.
- **A rescue with no host version wrote `[null]`** into the exemption file and produced duplicate,
  unauditable ledger entries. Both the entry point and the writer now refuse a missing version.

Also: button colour is now semantic (primary / danger / secondary) so a destructive action is never
the green one, the cleanup flow sits next to the findings it acts on rather than below the rescue
card, and the two rescue sections are separated from the finding list by a rule.

155 tests (14 new), 154 pass, 1 platform skip.

## 0.10.0 (2026-10-29)

### Added

- **`boot diagnose` now reads the host's own crash reports.** The CLI prints a boot failure to
  stderr and exits, leaving nothing on disk — but the desktop app writes
  `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<time>-{host,renderer}.log`, and that file
  contains the phase, the app version and the error text. When a plugin caused the failure, the
  error names it outright (`Plugin dsh-session-recall@0.1.0 is incompatible with dsh 0.2.1-rc.3`).
  The diagnosis now leads with that evidence and lists the blamed plugins directly, instead of
  only pattern-matching plugin-manager logs.

### Changed

- **The two choices offered when a plugin cannot be rescued are much shorter.** The previous copy
  explained the mechanism behind each option; a user staring at a plugin that will not load needs
  the decision, not the design. "Turn it off, keep using DSH" and "Let AI try to fix it", one line
  each.

141 tests (6 new), 140 pass, 1 platform skip.

## 0.9.0 (2026-10-29)

### Added

- **A plugin that cannot be rescued now gets two real decisions instead of one vague hint.**
  Each is a box with its own action, so the user is not left guessing:
  1. **Turn it off and keep using DSH** — writes a single `disabled: true` overlay to the
     profile patch layer. No files deleted, no plugin modified, reversible at any time.
  2. **Hand it to my AI** — writes the brief and prompt; the tool still never calls a model.
- **The AI prompt now states hard limits.** The previous version asked for a fix but never said
  when to stop, which invites an agent to keep editing until something appears to work. It now
  says explicitly: stay in the declarations when the boot test passed, make one diagnosis and one
  attempt if it did not, stop after two failed attempts, never widen a range to an unverified
  version, never suppress an error to make the boot "succeed", and treat "this needs the
  maintainer" as a valid answer.

### Fixed

- **`thirdPartyEntries` excluded this tool by id only.** A profile inserts us as
  `id: plugin-health`, `name: dsh-plugin-health`, so the name check never matched and safe
  mode disabled us along with every other plugin — removing the panel that explains the state.
  Both fields are matched now.

135 tests (6 new), 134 pass, 1 platform skip.

## 0.8.2 (2026-10-29)

### Fixed

- **`boot safe` disabled this tool along with everything else.** The self-exclusion only
  checked the entry `id` (`plugin-health`) and not the `name` (`dsh-plugin-health`), so a
  profile that inserts us the normal way was swept up with every other third-party entry. That is
  the one entry safe mode must always leave alone: it exists so the user can reach the health
  panel that explains what happened. Both fields are checked now, with tests.

131 tests (2 new), 130 pass, 1 platform skip.

## 0.8.1 (2026-10-29)

### Fixed

- **A brief generated with `--no-rehearse` claimed `Verdict: failed`.** No rehearsal had run,
  so the prompt told the agent the plugin was broken when nobody had checked — and the agent's
  first instruction was "work out why it fails to boot", chasing a failure that did not exist.
  `buildBrief` now emits a `not-run` verdict, and the prompt says plainly that the boot
  question is open and decides how much work the fix is.
- **The requirements table printed one line per peer.** A typical plugin repeats the same
  enumeration across twenty-odd packages, so a 24-peer plugin produced 22 near-identical lines
  and buried the one fact that matters: which range rejects the host. Grouped by range now, with
  the packages listed underneath, widest group first — 49 lines became 30.

129 tests (5 new), 128 pass, 1 platform skip.

## 0.8.0 (2026-10-29)

### Added

- **`boot` — the commands that still work when DSH will not start.** Everything else runs inside
  the host, which is exactly what is missing when a plugin stops boot. `boot diagnose` explains
  the failure from the logs the host left behind; `boot safe` disables every third-party entry;
  `boot restore` removes that overlay again. `safe` only appends `disabled: true` to the
  profile's own patch layer — nothing is deleted, no plugin is touched, and host entries are never
  disabled. Both writers default to a dry run and require `--apply`.
- **AI handoff and upstream reporting are reachable from the settings page**, not just the CLI.
  When a rehearsal proves a plugin cannot boot, the card offers "ask my AI to analyse it" and
  "see whether upstream already knows"; the first writes a brief and shows the prompt for the user
  to copy, the second searches GitHub and either links the existing report or prepares a draft. Both
  stop short of sending anything.
- **Recorded exemptions are listed in the panel and can be revoked there**, so undoing a temporary
  fix no longer requires a terminal. The list also flags a rescue as stale once a newer version is
  installed, which is the signal that upstream finally fixed it.

### Changed

- **A temporary exemption now requires an explicit confirmation step.** The card restates what will
  be written, that only an official exemption entry changes, that it is reversible, and — in the
  same breath — that this is not official support and features may still misbehave. The old flow
  wrote on the same click that revealed the verdict.
- **The two repair concepts are named apart.** The quarantine flow is now "clean up N broken
  files" (it deals with files a failed install left behind); the compatibility flow is "fix
  compatibility" (it deals with a plugin that cannot load). Both used to be called "repair", which
  left a first-time user choosing between two identical-looking buttons.

### Fixed

- `enterSafeMode` re-disabled entries that a previous run had already overlaid, so calling it
  twice kept appending. It now compares the set of ids already disabled.

124 tests (17 new), 123 pass, 1 platform skip.

## 0.7.0 (2026-10-29)

### Added

- **The whole settings page follows the host language**, not just the section label. Every string
  the panel renders — the description, severity labels, findings, repair plan, results and the
  sidebar alert — now comes from the host locale registry, so an English DSH gets an English
  panel. Contributed by [@po-et](https://github.com/po-et) in
  [#5](https://github.com/EasonMWS/dsh-plugin-health/pull/5), fixing
  [#4](https://github.com/EasonMWS/dsh-plugin-health/issues/4).
- The rescue flow is localized too, in the same pass here rather than later: it landed after #5
  was written, so all twelve of its strings were still hardcoded Chinese.
  `scripts/check-rescue-i18n.js` asserts the rescue block contains no CJK literals and that every
  key it uses exists in both dictionaries.

### Changed

- The host no longer composes the rescue verdict sentence: `verdictMessage` returns a
  `messageKey` and the browser half translates it. The host cannot know which language the user
  reads, so deciding there would have produced one language regardless of the setting.

## 0.6.1 (2026-10-29)

### Fixed

- **A packed tarball is no longer treated as a directory.** Identity resolution used
  existsSync alone, so reading <tarball>/package.json threw before the smoke run could
  install anything — which is what broke the two untime acceptance CI jobs on 0.6.0.
  Identity is now resolved only when --bypass-gate is set, directories are checked with
  statSync, and a file produces a readable request for 
ame@version.
- **The scan now honours the host's exact-version exemptions.** inspectRuntime evaluated
  compatibility without reading compatibility.json, so a plugin the user had just rescued
  was still reported as incompatible — the checker contradicting a state the host already
  accepted. Both directions are covered by tests: an exemption for the running version
  silences the finding, an exemption for a different version does not.
- The rescue apply handler called discoverDshDirectory with one argument instead of two,
  so it searched the wrong directories for an installed host.

102 tests (8 new), 101 pass, 1 platform skip.

## 0.6.0 (2026-10-29)

### Added

- **Rescue: verify, then repair.** A plugin rejected by the version gate is now rehearsed in a
  throwaway DSH home — the exemption is granted *there*, the plugin is installed and booted, and only
  if that succeeds is the exemption granted in the user's real profile. This closes the gap that
  static checks cannot: measured on `0.2.1-rc.4`, both `@nanmicoder/dsh-agent-teams@0.1.27` and
  `dsh-find-plugin@0.4.0` are rejected by their declarations yet boot completely.
  - `rescue --profile <p> --plugin <name@version>` rehearses and, with `--apply`, grants the
    official exact-version exemption. `--undo` revokes it; `--status` lists recorded rescues.
  - Every grant records the value that was there before, so undo restores it exactly instead of
    deleting a key the user (or the host) had already put there.
  - A failed rehearsal writes nothing at all: exempting a plugin that cannot boot would only hide
    a real breakage behind a gate that no longer warns.
- **Upstream tracking.** `rescue --status` polls the registry and distinguishes *a fix is published*
  from *a newer version exists but still rejects this host* — the two are easy to conflate and only
  the first one means the exemption can be dropped.
- **Report de-duplication.** `report --plugin <name@version>` searches the upstream repository for an
  existing report first. When one exists it links to it instead of drafting a duplicate; when none
  exists it prepares the issue text and the "new issue" link. Nothing is ever filed automatically.
- **AI handoff.** `handoff --plugin <name@version>` writes a brief, the rehearsal evidence and a
  ready-to-paste prompt asking a local agent to restore *compatibility only*. The prompt makes the
  boot test the acceptance criterion, so a "fix" that does not boot is explicitly a failure. This
  tool never calls a model and never spends the user's tokens; sending remains the user's decision.
- **Settings UI for the whole flow.** Each incompatible plugin gets a "can this be saved?" button,
  the rehearsal verdict, and — only when the verdict is positive — a temporary-exemption button.
  The rescue routes reuse the repair route's per-boot control key rather than minting a second one.

### Changed

- `smoke --boot-only` accepts activation alone, so UI-only plugins (which register no model-facing
  tools and therefore could never satisfy `--tool`) can finally be checked.
- `smoke --bypass-gate` grants the exemption inside the throwaway home only. Without it an
  incompatible plugin is simply rejected and the run proves nothing about whether it would work.
- Positioned as health check **and repair** in both READMEs, with the measured evidence, the
  verify-then-repair ordering, and an explicit safety-boundary table.

## 0.5.0 (2026-10-26)

### Added

- **`smoke` — isolated profile runtime acceptance.** The static matrix compares declared ranges,
  which cannot catch a manifest that declares compatibility while the bundle still waits on a
  service the host no longer provides (`runProfile` returns after a pending-entry warning). The new
  opt-in command installs a package or release tarball through the official CLI into a fresh
  `DSH_HOME`, boots it via the public `profile-boot` export, checks active entries and named tools,
  and optionally executes calls with expected return values. Each run retains a staged report and
  bounded logs; installation and runtime including shutdown are time-limited.

  ```sh
  dsh-plugin-health smoke \
    --dsh-dir /path/to/node_modules/@deepseek-ai/dsh \
    --plugin ./my-plugin-1.0.0.tgz \
    --tool my_plugin_tool \
    --calls ./smoke-calls.json
  ```

  Contributed by [@po-et](https://github.com/po-et) in [#3](https://github.com/EasonMWS/dsh-plugin-health/pull/3).

  Limits, stated up front: a fresh profile is **not** a security sandbox; automatic
  normal-exit descendant detection is not implemented on Windows; browser behaviour is out of scope
  for this check.

### Fixed

- **The matrix workflow no longer fails on pull requests from forks.** A fork PR always receives a
  read-only `GITHUB_TOKEN` regardless of the `permissions:` block, so the "comment the matrix on the
  PR" step died with `HttpError: Resource not accessible by integration` — turning the whole
  `self-matrix` job red even though the matrix itself passed 3/3 hosts. The comment step now runs
  only for same-repository PRs; for fork PRs the matrix stays in the job summary and the uploaded
  artifact, with a note explaining why no PR comment appeared. This affected every external
  contributor, not just one PR.

### Changed

- **Upstream follow-up: 4 of the 5 rc.3 regressions now ship fixes.** Re-verified on 2026-10-26:
  `@anionex/dsh-vision-toolkit@0.1.48`, `dsh-plugin-subscriptions@0.9.11`,
  `@nanmicoder/dsh-agent-teams@0.1.27` and `@goodandready/dsh-clinebot@0.6.16` all pass the matrix
  on both `0.2.1-rc.2` and `0.2.1-rc.3`, so the affected count in `docs/upgrade-0.2.1-rc3.md`
  drops **5 → 1**. The one remaining is `dsh-workbuddy-connect@0.7.9` — the only case where the
  repository was unreachable, so no report could be filed at all.
- `docs/upgrade-0.2.1-rc3.md` now records the fix timelines and, more importantly, **corrects the
  fix advice**: "use a range instead of enumerating" is not always applicable. Repositories that run
  their own host-version enumeration check (e.g. `dsh-agent-teams`' `scripts/compatibility.mjs`)
  must enumerate — a range fails that gate. The guidance now branches on whether such a check exists,
  and recommends adding a real rc.3 CI lane either way, because a static declaration cannot prove
  the plugin actually boots.
- Both READMEs show the per-plugin fix status table instead of a single "maintainers acted" quote.
- Fixed the version in both README status lines, which still said `0.4.2`.

## 0.4.3 (2026-10-25)

### Changed

- Both READMEs now explain the concrete gap this package fills, with the verbatim behaviour: DSH
  **rejects a new install** whose declared range excludes the running version, but **does not
  re-check already-installed plugins** after a host upgrade — a plugin declaring
  `engines.dsh: 0.2.1-rc.2` keeps loading on `0.2.1-rc.3` with no warning in the UI.
- Added the first documented upstream outcome: [Anionex/dsh-vision-toolkit#178](https://github.com/Anionex/dsh-vision-toolkit/issues/178#issuecomment-6388178989)
  (906★) confirmed the scan's finding ("19 DSH peers were rejected, while rc.2 still passed"), fixed
  it on main, and added a required rc.3 profile lane to CI.

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
