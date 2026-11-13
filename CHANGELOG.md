# Changelog

## 3.1.1

Removes a warning that was wrong on every host this tool supports, and whose advice could stop the
desktop app from starting. Reported as [#7](https://github.com/EasonMWS/dsh-plugin-health/issues/7).

### The `proxy-env` finding is gone

`doctor` warned whenever a proxy was configured without `NODE_USE_ENV_PROXY`, on the belief that DSH's
own requests went through plain global fetch. It does not:

- `@deepseek-ai/dsh-http-proxy` is called during profile boot, and `installProxyFromEnvironment` is
  reached from **every** `@deepseek-ai/dsh` from 0.1.7-rc.2 through 0.2.2-rc.1 — checked by installing
  each version and grepping for the call.
- At boot it resolves the policy, writes it into its own environment, and installs an undici global
  dispatcher, so the host's requests are proxied.
- It deliberately does **not** set `NODE_USE_ENV_PROXY` on itself. That name appears only in
  `proxyEnvironmentForChild`, the overlay built for spawned processes.

So "proxy configured, flag absent" is the healthy state of every supported install, not a fault.

### The advice was worse than the false alarm

The finding told people to set `NODE_USE_ENV_PROXY=1` in the environment that starts DSH. Node reads
that flag in its prelude, **before any JavaScript runs**, so a scheme-less value such as
`127.0.0.1:6074` — the spelling the Windows proxy dialog and `npm config set proxy` both produce, and
one `dsh-http-proxy` tolerates — makes the process exit with `ERR_INVALID_URL` before the window
exists.

Reproduced on Node 24.19.0:

```
http_proxy=127.0.0.1:6074                      → starts normally
http_proxy=127.0.0.1:6074 NODE_USE_ENV_PROXY=1 → exit 1, TypeError: Invalid URL, no output
```

The check is removed rather than narrowed to hosts below `0.2.2`: there is no host in range without the
dispatcher, so a version gate would have left the false positive in place across the whole supported range.

Removed with it: the matching entries in the Settings copy (both languages) and in both README checklists.
Three regression tests pin the healthy tuple, the surviving environment findings, and the absence of the
flag in any user-facing copy. The middle one exists because the first would otherwise have passed
vacuously — an earlier attempt at the fixture passed a profile *path* where a *name* was expected, so the
scan returned before it reached the environment code.

## 3.1.0

### Every result can now be used as evidence

`smoke.json` records what was installed and by what: the tool's own version, Node, platform, pnpm and cordis,
each installed package's exact version and integrity (read back from the trial profile's lockfile), and how
long each stage took. A failed run says why, as one of a fixed set of kinds — `gate-rejected`,
`missing-service`, `peer-conflict`, `not-activated` and twelve more — classified from the stage that failed
only. `runtime.json` records what the profile occupies: every loader entry and every tool name, before the
activation assertions, so a failed boot still shows what registered.

### `verify`: many plugins, one level each

`dsh-plugin-health verify` boot-tests a list of plugins, always with a clean environment, and gives each a
level: `V1` its declaration admits the host, `V2` it installs, `V3` every entry activates. A plugin whose
declaration rejects the host is also run once with an exemption inside the throwaway home, and recorded as
`bypass` without raising its level — "the declaration is stale" and "the code is broken" are different
findings. Footprints are kept relative to an empty profile on the same host, and plugins that add the same
tool name or entry id are listed as predicted conflicts. Results are cached by package bytes, host and tool
line, and can be sharded.

### The compatibility page shows what the table could not

- Boot results for the latest host, with the failure in words and a link to the evidence.
- **Next build:** 90 plugins on 2026-11-09 were accepted by `0.2.2-rc.1` while their own declarations will
  reject `0.2.2-rc.2`. The page marks them before their users find out.
- **Fix hints:** each rejected row suggests a range (marked a suggestion), and says when it crosses a host
  line the plugin was never built against.
- **No declaration** is shown as ○, not as the tick a declared pass gets — 1,736 plugins.
- **GitHub-only plugins** (about half the catalogue) are judged from the package.json on their default
  branch, and marked as such.
- **History:** a daily snapshot on the `verify-data` branch, so a row can say "rejected since" and "fixed on".
- Per-plugin anchors and JSON, and a live shields.io badge for authors.
- 3.17 MB and ~72,000 DOM nodes became 176 KB and ~1,900; a filter went from ~700 ms to ~3 ms.

### Corrections

- **DSH does re-check installed plugins at startup.** The README said a plugin rejected after an upgrade
  "keeps loading". It is skipped, with one line on stderr and nothing in the UI. Verified in
  `@deepseek-ai/dsh-app-boot` 0.2.0-rc.2 through 0.2.2-rc.1 and by booting a real profile.
- `matrix --concurrency` was accepted and ignored; lookups ran one at a time. A full scan went from about
  twenty minutes to two.
- The publish workflow interpolated an input into a script; it now goes through the environment.

## 3.0.8

### The data this tool produces is now checkable

Three things were wrong in ways that made the numbers untrustworthy, and none of them were in the checks
themselves.

**The compatibility page counted a host nobody runs.** It asked for `latest,next,alpha` by name, and on
2026-11-08 `alpha` pointed at `0.2.2-alpha.3` — five days *older* than `latest`. 135 plugins were reported
as rejected because of it. The page now chooses its hosts (`--versions current`): the latest release, a
dist-tag only when it points ahead of latest, and the previous release line. The headline counts rejection on
the latest host; "rejected by at least one" is still shown, as secondary information. Each column is labelled
with its role, and the tags that were left out are named.

**The runtime acceptance job tested two releases nobody ran.** It was pinned to `0.2.1-rc.2` and
`0.2.1-rc.3` while the current host was `0.2.2-rc.1`. Hosts now come from the registry at run time, plus one
fixed older release as a regression baseline.

**The plugin under test inherited your whole environment**, including any token in it. `smoke --clean-env`
passes only what a host and a package manager need, refuses anything whose name looks like a credential, and
records the names it passed — never the values. The default is unchanged, and that is deliberate: the existing
behaviour is documented, and changing it silently would be worse than the exposure.

### The tool execution contract changed between host lines

Fixing the runtime job's host list surfaced two things it had been hiding.

The acceptance fixture declared `engines.dsh: >=0.2.1-rc.2 <0.2.2-0` — it never claimed to support 0.2.2 at
all, so the host correctly rejected the "healthy" fixture and the failure looked like a tool defect.

More seriously: `smoke`'s tool assertions were calling an API that no longer exists in that shape.

```
0.2.1.x  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>    one call
0.2.2.x  execute(input: ToolBatchInput): Promise<ToolBatchResult>          a batch
```

Both host lines are in the field, so both are supported. The choice is made by capability (`executable()`,
which arrived with the batch contract) rather than a version table, because a table needs editing on every
host release and is wrong for anything not on it. The mode is recorded as `toolApi` in the report.

This is why the old job, pinned to two 0.2.1 releases, never saw it: `smoke` had not worked on the host
people run since 0.2.2 came out.

### A new check on the compatibility judgement

`src/compat/evaluate.js` is a local copy of the host's judgement, and the note on top claimed the official
build does not export it. That stopped being true: `@deepseek-ai/dsh-app-boot@0.2.2-rc.1` exports
`evaluatePluginCompatibility`.

A copy that diverges quietly makes every verdict wrong. `test/fixtures/compat-corpus.json` now holds 41 cases
whose **expectations were captured by running the official implementation**, and `scripts/compat-drift.js`
re-runs them against an installed official build in CI — weekly, on demand, and on pull requests that touch
the mirror or the corpus. Run against `@next` today: 41 of 41 agree.

### One host contract is now checked instead of assumed

The activation check relies on the literal `FIBER_ACTIVE = 2`, which cordis declares as a `const enum` and
erases at compile time, so it cannot be imported. Nothing noticed if it changed. If none of the official
`@deepseek-ai/` entries report that state, the run now fails with `host-contract-changed:` — naming the host
contract rather than the plugin under test. The host's cordis version is recorded in `runtime.json`.

### Documentation corrected

Six statements had stopped being true, all checked against the thing they describe before being changed: the
declared host range in both READMEs, a unit-test count, the upgrade advice, a claim that the official plugin
manager has no version picker (it exports `listVersions`, `updateBundle`, `listVersionExemptions` and
`setVersionExemption`), and absolute paths in `DEVELOPMENT.md`.

One item was deferred rather than guessed: whether the official host re-checks `engines.dsh` at profile boot
could not be verified from the published package, so that section is unchanged.

## 3.0.7

### The upgrade preview is now visible without switching views

The feature already existed and worked: point it at `0.3.0-rc.1` and it names the four installed
plugins whose declarations would reject that host, this one included. But it lived behind
`hidden: !advanced`, so the default daily view never showed it.

That mattered. Eight unique visitors went to `docs/upgrade-0.2.1-rc3.md` — a report generated with
this very feature — while the panel offered it only to people who first switched to a diagnostic view.

Every view now carries a compact preview: one field, pre-filled with the running version, and one
sentence back. The full version with the package list, patches and findings stays where it was, in
advanced mode.

The answer is worded to stay inside what was actually checked: "3.0.6: 4 plugins would be affected.
Nothing was changed." It reports declaration mismatches, not whether the plugins work.

### Also

- The clean state's action list no longer offers "check which plugins a DSH version would break" as a
  clipboard command. Copying a command is worse than the input field now sitting above it.
- Both previews had the same field label, which made them ambiguous to assistive technology. The
  compact one has its own.

### Verified

- Real data: previewing `0.3.0-rc.1` against the local profile returns the four affected plugins,
  including this one.
- 375 unit tests, 374 pass. 35/35 over real HTTP. 20 browser checks.
- Rendered in a browser and read back: the card appears in daily mode, pre-filled, no runtime errors.

## 3.0.6

### The clean state now says what the tool is for

A user who installs this to guard against a future DSH upgrade opens the panel, sees "✓ no problems
found", and has no reason to open it again. The panel never said what it was watching for or what it
could do in the meantime.

The clean state now carries two things: what it is waiting for ("after the next DSH upgrade, if a
plugin is rejected, this panel will say which ones can be saved"), and three things to do now — check
whether any plugin works on a given DSH version, check the configuration for problems, and browse the
public compatibility table.

The first two are CLI commands. The client half of this plugin cannot shell out, so they copy the
command to the clipboard and confirm it, rather than presenting a button that would do nothing.

### Verified visually

Rendered the clean state in a browser and read it back: the two action buttons appear, the text
matches the intended copy, no runtime errors.

## 3.0.5

**3.0.4 was published with the wrong content.** Its publish workflow was cancelled while still running, but npm had already accepted the tarball — so 3.0.4 on the registry is byte-identical to 3.0.3. This release carries the changes that were meant to be in it.

### The settings markup is read from DSH instead of invented

The dialog is recognised by `data-shortcut-modal="settings"` and the button by `aria-haspopup="dialog"`, both taken from `@deepseek-ai/dsh-client-ui-settings-general` 0.2.1-rc.4 (`lib/client.js:280-293` and `:451-462`). The same markup is in 0.2.0-rc.2, 0.2.1-rc.5 and 0.2.2-rc.1, so the previous guesses affected the whole supported host range.

What that looked like in practice: on the desktop build the settings dialog opened and the sidebar strip still said it could not. The earlier fix, which matched buttons by their label text, could also press another plugin's "Reset all settings" control.

### No synthetic keyboard event

The desktop build receives shortcuts natively and its DOM keydown handler returns early, so a dispatched event does nothing there. The web build treats the shortcut as a toggle, so pairing it with the click would close settings again. Clicking the shell's own button is the one path that works on both.

### The failure message no longer names a key combination

"Ctrl+Comma" was wrong on macOS (Cmd), wrong on the web build (Ctrl+Alt), and wrong for anyone who rebound the shortcut. It points at the settings button instead.

### The tests use the real markup

They previously used attributes this tool invented, which is why twenty browser checks passed while the button did not work: the tests shared the code's assumption about the host. Helper extraction now throws instead of substituting placeholder functions — a scene expecting "could not open" had been passing against a placeholder that always returned false.

### Smaller fixes

- `src/rescue/boot.js` parsed the profile patch in two places without the YAML complexity guard. Both are guarded now; 10k anchors plus 10k aliases in a 230KB file measured ~3s.
- `--expose-internals` removed from the rehearsal worker. Verified unnecessary by booting the real 0.2.1-rc.4 host without it. It had been handing the plugin under test Node's internal bindings and making the rehearsal differ from the real host.
- 18 files were CRLF while `.gitattributes` asks for LF. Converted.

### Verified

- 375 unit tests, 374 pass, 1 platform skip
- 35 HTTP checks against the real route registration
- 20 browser checks, using markup copied from the published DSH package
- Five scenes against the real markup: dialog opens and is recognised, button ordering does not matter, no settings button means an honest failure, a gear without `aria-haspopup` is never pressed, an unrelated dialog is not mistaken for settings

### Still not done

- **The rehearsal inherits your whole environment.** `src/runtime/smoke.js:246` is `{ ...process.env }`, so a plugin under test can read every `*_TOKEN` and `*_KEY` you have exported. That is this tool's own risk to fix.
- The single-plugin disable route does not exclude Health itself or `@deepseek-ai/*` host packages.

## 3.0.4

Cancelled before it could publish; the registry copy is byte-identical to 3.0.3. Superseded by 3.0.5.
See that entry for the changes that were meant to ship here.

## 3.0.3

### The loader list got searchable, and the counters explain themselves

Three changes from watching someone use the panel.

The three startup counters were labelled Active / Failed / Other states. "Other states" held six
different things — waiting, loading, unloading, inactive, disabled, absent — so the number answered
nothing a reader could act on. Each counter now carries a line saying what it counts, and the vague
one is called "not running" with the actual states named underneath.

The loader list was a flat run of two hundred-odd rows mixing the host's own packages with the ones
you installed. It now groups by origin — the host ships under `@deepseek-ai/` — and has a search box
filtering on name and id. The question a reader has is "is the thing I installed healthy", which is
a different question from "is the host healthy".

The target-version field was empty and required, so the preview button refused to fire until the
reader looked up the version they were already on. It starts at the running version.

Daily mode now shows the counters too. That is the point of them: a number answers "is anything
broken" faster than a sentence, and the sentence was what a first-time reader had to decode. Daily
mode still keeps the technical vocabulary out.

### Fixed

- The loader-list search check never ran. The disclosure trigger is a toggle, and earlier checks in
  the same file had already opened it, so an unconditional click closed the very panel being tested.

### Documentation

- Removed two passages that were genuinely out of date: the step-2 caveat said no exemption was
  written while the next line said one was, and the roadmap listed five capabilities as future work
  that all ship today.

## 3.0.2

### The declared host range now matches what has been booted

`engines.dsh` said `>=0.1.0-rc.6 <0.3.0-0`. That span was written when the project started and never
re-derived; the package had only ever been installed and booted on 0.2.1-rc.4.

Three hosts have now been installed and booted for real: 0.2.0-rc.1, 0.2.1-rc.4 and 0.2.2-rc.1. All
three load this plugin cleanly. The lower bound is now `0.2.0-rc.0`. 0.1.x belongs to an era current
users are not running, and could not be exercised here at all — installing it timed out resolving a
61-package dependency tree.

A tool whose whole argument is *do not declare what you have not tested* cannot carry an untested
lower bound in its own manifest.

The test that pinned this asserted compatibility with 0.1.7-rc.2 and two other versions that were
never installed, so it was checking the range against itself.

## 3.0.1

Documentation only. No code changed — the package is 3.0.0 plus a fuller README, published so the
npm page carries it.

- **Two sections the 3.0 README was missing.** What layer 1 examines beyond version declarations
  (duplicate insert ids, module replacement, fields a later patch layer overwrites, host-core packages
  copied into a profile, overlapping shared-write declarations), and how a plugin is rehearsed beside
  its peers with repeated `--with`. Both are described in English and Chinese.

- **"Overlap", not "conflict".** A declared write to the same path is evidence of a risk, not proof
  that two plugins raced. The section says so, because calling it a conflict would be the kind of
  claim this project spent a release removing.

- **The companion check is explained where it is documented.** It requires each named package to reach
  `active` in the loader; a same-named entry does not satisfy it, which is the failure it exists to
  catch.

Also fixes the README's install-version line, which still said 3.0.0.

## 3.0.0

Three rounds of external review caught real defects in this release before it shipped — two of them
in fixes from the round before. What is published here is the third attempt at the same two problems,
and both were reproduced from the reviewer's own scripts rather than taken on trust.

### Breaking changes

- **Repairing from the routes is two steps now.** `POST /repair` with `{dryRun: true}` returns a
  `planToken`; applying must send it back as `{dryRun: false, planToken}`. A client that posts
  `{dryRun: false}` without a preview gets 409. The old single call could not tell a plan the user had
  reviewed from one replayed by anyone else, which was the point of the change.

- **Rescue actions refuse a plugin that is not installed at the stated version.** They already did
  since 2.0.0; the check now also runs before the rehearsal rather than after.

- **A damaged `compatibility.json` is refused rather than rewritten.** Unchanged from 2.0.0, restated
  because it is still the most common surprise.

### Added

- **A reliability report that reads configuration the tool did not write.** Installed packages, the
  declared ranges of both the running and a target host, every patch layer, and an unpacked candidate
  directory. It finds duplicate insert ids, module replacements, fields dropped by a later layer,
  host-core packages duplicated inside a profile, and voluntarily declared shared writes.

  It reports *overlap*, never *conflict proved*: a declared write to the same path is evidence of a
  risk, not proof that two plugins raced. The findings say so.

- **Live loader state.** Every status read samples pending / loading / active / failed / not-active /
  unloading / disabled, and keeps the last 24 transitions in this host's memory. It cannot intercept
  file, network or process behaviour, and the code, the documentation and the panel all say that
  rather than implying otherwise.

- **Three display modes** — daily, advanced, developer — stored in localStorage. They change wording
  and how much detail is shown, not what is detected. Daily mode still surfaces every failure and
  keeps every confirmation step.

- **Combined startup checks.** A plugin plus up to twelve companions install into one throwaway data
  directory and boot together. The check requires each named package to actually reach active in the
  loader, so an unrelated entry with a similar id cannot stand in for it.

- **Repairs can be undone.** A schema-2 repair log records what was moved; `restoreRepairs()` previews
  first, runs in reverse order, and returns `blocked` when the configuration or its backup changed
  underneath it.

### Security

- **The YAML parser was bounded by bytes, not by work.** Alias resolution costs time with the square
  of the alias count — 20k aliases in a 224KB file took two seconds, and a 692KB file took 212
  seconds — and `maxAliasCount` only applies later, during `toJS`. A plugin nobody ever loaded could
  ship such a patch and stall the host on every status poll. Parsing now counts anchors and aliases
  with yaml's own lexer before handing anything to the parser, and caps flow-collection depth.

  The first attempt at this counted with a regular expression and could be bypassed by an anchor name
  starting with punctuation or a non-ASCII character. Six of the seven names the reviewer tried got
  through. The lexer does not have that problem because it is the grammar.

- **Origin checks compare the scheme** as well as host and port, and apply to reads that arrive
  without Fetch Metadata.

- **Repair previews are bound to a single-use token** carrying the environment, the actions, the
  target metadata and a small file hash. Replay, staleness and a changed plan all return 409.

- **Rescue dispatch reaches only its own registered functions**, so `constructor` and `__proto__` are
  not actions.

- **A request-supplied host directory must resolve inside the DSH_HOME**, carry the exact running
  version, and have its executable resolve inside its own package.

- **Self-update passes `--ignore-scripts`** and no longer overrides `minimumReleaseAge`. It refuses to
  move backwards, and reports a warning when the version it installed would not load on the running
  host.

- **The AI brief treats plugin-supplied strings as data.** Ranges are validated with semver, names
  are filtered to the characters a package name may contain, errors are quoted and labelled, and the
  `Repository:` line is printed only for a plain `owner/repo` URL. A manifest could otherwise write
  its own instructions into a prompt the user pastes to an agent holding repository write access.

### Fixed

- **The install action could never have worked in a real host.** It read `profileDir` off a context
  that supplies only `home` and `profile`, so every request answered 400. Every test built its own
  context and included the field. There is now a test that goes through `plugin.apply()` with a
  host-shaped context over a real socket, and it fails when the fix is reverted.

- **Processes launched from the desktop build were the desktop build.** Inside Electron,
  `process.execPath` is the application binary, so a rehearsal, a self-update and a host download each
  started a second copy of the app instead of the script. They now pass `ELECTRON_RUN_AS_NODE`.

- **The publish workflow could not publish a prerelease at all**, and on an older npm would have
  published one as `latest` — pushing a beta to everyone reading `/latest`, including this tool's own
  update check. The dist-tag is derived from the version.

- **A plugin the user switched off kept being reported as incompatible**, and the panel offered the
  same fix again.

- **The rescue routes did not invalidate the status cache**, so the UI reloaded a snapshot predating
  the action it had just taken.

- **Generated issue text suggested ranges that still rejected the host**, and the AI brief claimed a
  passing boot test when none had run.

### Documentation

- README, SECURITY.md and the panel now state that this tool does not contain malware and cannot stop
  a plugin from writing outside the workspace, sending data, launching programs, or acting after a
  normal activation. A throwaway data directory is a directory, not a sandbox; the worker inherits the
  account's permissions. Earlier wording about a "fully isolated environment" and a "complete
  rollback" is gone.

- Every claim about *other* tools was removed. Several packages in this ecosystem overlap with this
  one, and a comparison the reader cannot check is not worth making.

### Verified

- 368 tests, 367 pass, 1 platform skip (a POSIX process-group test that does not apply on Windows).
- 35 HTTP checks against the real route registration.
- 17 browser checks in Edge against a synthetic host.
- Four fixture outcomes against the official `0.2.1-rc.4` host: healthy boots, pending / throwing /
  hanging fail as expected.

### Not verified in this release

- **Native DSH desktop injection.** The panel renders correctly in a real install and reports the
  running host version, but a repair has not been driven end to end from the desktop UI.
- **Refreshing the page between an install and a restart.** Whether the new client meets the old
  routes in memory depends on the host, and has not been observed.
- **Node 20 / 22 and Linux CI** for this revision; the review ran the suite on Linux with Node 20 and
  22, but the project's own CI matrix has not been run for this commit.

These are the reason to exercise the beta channel before pointing `latest` at this version.

## 3.0.0-beta.4

- Matched daily, advanced and developer wording to their audiences in Chinese and English. Daily
  users see impacts and next steps; diagnostic paths and raw errors remain available on demand.
  Changing the view does not change permissions, protection requirements or reported failures.
- Made the malware boundary visible in every view: Health observes installation and loading,
  but cannot contain malware. Corrected documentation and metadata that overstated trial isolation,
  recovery or the meaning of a passing check.
- Required an explicit trust confirmation before every UI startup trial, including retries.
  The confirmation explains that installation and execution retain the current account's access.
  Cancelling performs no trial; repeated confirmation cannot launch duplicate requests.
- Isolated trial state per plugin, version and profile so one result cannot authorize a different
  card. Failed report queries no longer appear as a successful search with no reports.
- Added audience, confirmation, state-isolation and report-failure regression checks, plus real
  browser coverage of the revised wording and trial workflow.

## 3.0.0-beta.3

- Reworked the settings layout with scoped styles, theme-aware colors, narrow-screen wrapping and
  clearer tasks for each view. Mode switches retain the upgrade preview and disclosure state.
- Added keyboard-accessible animated disclosures. Closed content is inert and hidden from assistive
  technology; reduced-motion preferences also apply to confirmation scrolling.
- Kept the last results after a failed refresh, labeled them stale, and prevented late responses from
  overwriting a newer scan. Read requests have a 15-second deadline, and a failed sidebar poll no
  longer clears existing warnings. Update checks and installation cannot overwrite each other's state.
- Bound repair confirmation to a five-minute, one-use preview token. Changed targets require a new
  preview. Failed repairs show their reason and let the user build a fresh plan before confirming.
- Added a real React/Edge component acceptance script covering mode changes, keyboard controls,
  preview state, downloads, 360px layouts, reduced motion and dark appearance.
- Hardened local write origin checks, rescue action and installed-package identity checks, host
  directory validation and self-update installation policy. Browser report links accept only HTTPS
  GitHub issue URLs without credentials.

## 3.0.0-beta.2

- Added three persistent settings views for daily checks, advanced diagnostics and developer verification.
- Sampled live loader state independently of cached disk scans, highlighted activation failures and kept recent observations in memory.
- Added developer export of live evidence and recognized duplicate tool registration diagnostics without exporting raw errors.

## 3.0.0-beta.1

- Added a settings and CLI review of installed packages, host activation evidence, target-version declarations,
  literal configuration overrides, and optional shared-file declarations. Saved snapshots can be compared offline.
- Added a smoke test for a user-selected plugin combination and a recovery preview for repairs in the default quarantine.
- Fixed Windows startup check timeouts when the process-tree termination command fails.
- Limited self-updates to the package managers supported by the installer and clarified the evidence shown after a startup check.

## 2.2.1 (2026-11-03)

### Fixed

Two defects in 2.2.0's one-click update, both found by running the installer against a real pnpm
profile rather than an injected runner:

- **The install failed outright on pnpm 12.** The command passed `--no-frozen-lockfile`, which `pnpm
  add` no longer accepts — it exits with a usage error before touching anything. The flag that does
  the useful work here is `--yes`, which turns a prompt into an answer.

- **A test assumed the native executable is always there.** CI installs pnpm outside the Node
  directory, so the `.cmd` shim route is genuinely reachable; the assertion demanded the native path
  and failed on windows-latest while passing locally. The route is now asserted for its shape — a
  shell is acceptable only for the shim, and the spec stays one argument — with a separate test that
  forces the fallback.

- **The Windows invocation fell back to a shell.** It looked for `node_modules/pnpm/bin/pnpm.cjs`,
  which does not exist (pnpm's entry point is `pnpm.mjs`), so it dropped to the `.cmd` shim with
  `shell: true`. pnpm ships a native `pnpm.exe`; that is used now, so the install runs with
  `shell: false` and arguments that are escaped rather than concatenated.

Verified end to end afterwards: `2.1.0 → 2.2.0` in a real pnpm profile, four seconds, with the
package manager's own output recording the version change.

307 tests (1 new), 306 pass, 1 platform skip.

## 2.2.0 (2026-11-03)

### Added

- **An update can be installed from the panel.** Until now the panel told you a new version existed and
  printed a command; acting on it meant opening a terminal, which is the thing this plugin exists to
  avoid. Checking now ends in an **Update now** button.

  This is the most dangerous operation the package performs — it replaces the plugin's own code in a
  profile DSH is booting from — so it is deliberately conservative:

  - **The profile's own package manager runs the install.** A profile here is a pnpm workspace; running
    `npm install` into it produces a tree pnpm cannot reconcile, and the next `dsh plugin add` then
    fails for a reason unrelated to the plugin being installed. The manager is detected, not assumed.
  - **Non-interactive.** pnpm prompts about new releases and about supply-chain policy; in a background
    process a prompt is a hang. The invocation passes the flags that turn prompts into decisions, and a
    finite timeout abandons it if it still blocks.
  - **Success is judged by what is on disk**, not by the exit code. A package manager can exit 0 and
    leave the old files in place; believing the exit code would show a successful update while the user
    keeps running the old code.
  - **The version is validated** before it reaches a command line, and only the exact version the check
    found is installed — never a range.
  - **One install at a time.** A second click joins the first rather than starting a second package
    manager against the same directory.
  - **Restart is stated, not performed.** The files change; the running host keeps the code it loaded.
    The panel says so. Restarting on the user's behalf would end their session without asking.

- **A quiet sidebar notice when an update exists.** The boot-time check already ran and its answer is in
  the status snapshot, so the sidebar can mention an update without a request of its own. It appears
  only when there is something to say, and it yields to broken plugins: findings lead, because a plugin
  that will not load is why someone is looking at this panel.

- A failure shows the package manager's own message, not just an exit code, plus a retry button.

306 tests (14 new), 305 pass, 1 platform skip.

## 2.1.6 (2026-11-03)

### Added

- **The published site now says what it is, to a search engine and to a link preview.** The landing
  page had a title and nothing else: no description, no canonical URL, no Open Graph tags. It read
  "DSH Plugin Health Index" — the name of an artefact, which is not what anyone types into a search
  box. The description now leads with the symptom (plugins that stopped loading after a DSH upgrade)
  and follows with the evidence, and both pages carry `og:` and Twitter card tags so a shared link
  renders as something.

- **A sitemap and a robots.txt are published with the site.** Without a sitemap, a crawler has to
  discover the compatibility table and the index by following links from one page; with one it is
  told, once, that four URLs matter and that they change daily. Both are generated in the deploy
  step, so they cannot drift from what was actually published.

- **Both READMEs link to the compatibility table within the first screen.** A reader who is not ready
  to install a package should still be able to check the plugin they are worried about, and that link
  was below 200 lines of prose.

### Fixed

- The compatibility page had a description but no canonical URL, so a preview of it and a preview of
  the landing page could look like two different sites.

292 tests (4 new), 291 pass, 1 platform skip.

## 2.1.5 (2026-11-03)

### Changed

- **The docs no longer position this against other tools.** Several packages in this ecosystem overlap
  with it, so "the checker that can actually repair" and "a static checker would report these as
  broken" are claims about someone else's output that the reader cannot check and that are not
  necessary to make the point. The measurement is the argument: three plugins rejected by identical
  declarations, two of which boot and one of which does not. The section now says that, and stops
  there.

  Section titles changed with it: "What makes this different: four layers, not one" became "What
  happens between 'rejected' and 'fixed': four layers", and the same in Chinese. The npm description
  now opens with what the package does rather than with what it can "actually" do.

- **The honest comparison stayed.** "Reading declarations cannot tell them apart" is the reason the
  rehearsal exists, and it is a statement about this package's own method, not about other packages.

- **A test enforces the distinction.** `test/docs-tone.test.js` fails on "the only <thing>", "unlike
  other tools", "can actually", and the Chinese equivalents — while deliberately not matching the
  innocent uses of the same words: "only then decides", "we only prove it boots", "read-only",
  "Git-only plugins". A word-based rule would have flagged all of those; the rule is placement-based.

288 tests (3 new), 287 pass, 1 platform skip.

## 2.1.4 (2026-11-03)

### Documentation

- **The README still told readers to upgrade to 1.1.0.** An external review spotted it: the Security
  section had not moved since that release, so a reader landing on the page in November was told the
  newest problem was the 1.0.2 key disclosure — while 2.0.0 had shipped a high-severity advisory and
  2.1.1 had fixed a loopback bypass that lets a LAN client disable your plugins. The section is now a
  version table covering all of 1.1.0, 2.0.0, 2.1.1 and 2.1.3, with both advisories cited and the
  LAN-binding caveat stated.

- **Neither README described the 2.1.0 features.** The on-demand update check, the link to the public
  compatibility table, and the quiet boot-time update check were shipped but undocumented; the
  `DSH_PLUGIN_HEALTH_NO_UPDATE` opt-out existed only in a changelog. Both languages now have a
  controls table and an explanation of why the check is silent by design.

- **"What 1.0 promises" was describing a line that no longer ships.** Renamed to 2.x, with the three
  deliberate 2.0.0 breaks restated so the frozen list is not read as covering them. The status-route
  row now also mentions the `key` field added in 2.1.3, because a security-relevant addition should
  not be something a reader discovers by inspecting the payload.

- Five tests now fail if the README drifts again: both languages must document the same features,
  both advisories must be cited in both files, the upgrade advice must not name a superseded version,
  the promises heading must match the shipped major, and every internal anchor must resolve.

280 tests, 279 pass, 1 platform skip.

## 2.1.3 (2026-11-03)

### Fixed

- **The panel's buttons still failed after 2.1.2, because the key never reached the page.** 2.1.2
  assumed a stale cookie: the control key is minted per launch and delivered as an HttpOnly cookie,
  and cookies are scoped by host rather than port, so a restart on a new port looked like the cause.
  It was not. On a real installation with 2.1.2 running, refreshing the key changed nothing — the
  write routes still answered 401 on every attempt.

  The cookie is set on the response and does reach the client, but it is not sent back on the write
  requests in this host, and there is no way for the page to tell. So the status snapshot now carries
  the key in its body as well, and the client keeps it in memory and sends it as
  `X-Plugin-Health-Key` — the same header the routes already accept. The cookie remains as the
  primary channel for any host where it works; the header is the path that does not depend on it.

  This is not a weaker boundary than the cookie. A local process could already read `Set-Cookie` from
  that same response, which `SECURITY.md` states plainly; what keeps a page on another origin out is
  the peer and same-origin checks, not where the key is stored. The one real difference is that page
  script in the DSH origin can now read the value, so an XSS in another plugin could take it — and
  such a plugin already runs with the user's full permissions.

- **An authentication failure was reported as a network failure.** "Could not reach the registry:
  missing or invalid control key" sent the reader to check their connection, which is never the
  problem. A refused key now says so, and says to reload.

### Changed

- `http-smoke.js` gained the case that would have caught this: a write authorised by the key read
  from the status body, with no cookie at all — 19 checks.

280 tests, 279 pass, 1 platform skip.

## 2.1.2 (2026-11-03)

### Fixed

- **The panel's buttons stopped working after a DSH restart.** The control key is minted per launch
  and delivered to the page as a cookie, and cookies are scoped by host rather than port — so after a
  restart the browser kept sending the previous launch's key. Every write route answered 401 and the
  UI showed it as "could not reach the registry", because that is the message the update button
  reports for any failure.

  A page reload cleared it, which is a bad answer: being told to reload after a restart, with no
  explanation, is indistinguishable from the plugin being broken. All three write paths now refresh
  the key from the status route — the one endpoint that issues the cookie — and retry exactly once
  when they see a 401. Any other status is passed through untouched, because a 400 is an answer, not
  a stale credential.

  Found on a real installation: upgrading 1.1.0 to 2.1.1 and restarting produced a 401 on every
  write until the page was reloaded.

279 tests (2 new), 278 pass, 1 platform skip.

## 2.1.1 (2026-11-03)

A second review of 2.0.0 found that four of that release's fixes were incomplete or ineffective, and
that three of the HTTP smoke checks proved nothing. This release finishes the job and, where a claim
in the previous notes was still too strong, narrows it.

### Security

- **The loopback check only looked at the `Host` header.** That header is written by the client, so
  with the web server bound to a LAN address — which the host supports, and which its own README
  calls deliberate network exposure — any machine on the network could send `Host: 127.0.0.1:<port>`,
  pass every check, call `/status`, receive the control cookie, and then disable plugins or run a
  rescue. The peer address is the part of a connection a client cannot choose, so all four handlers
  now require it to be loopback as well: the whole of `127.0.0.0/8`, `::1`, and the `::ffff:127.x`
  form a dual-stack socket reports. The `Host` check stays, because it is what stops DNS rebinding.
- **A request body could still choose what got installed.** `requireInstalledPlugin` verified that
  `foo@1.0.0` was installed, then passed the string `"foo@1.0.0"` down the chain — where
  `runRuntimeSmoke` treats a spec that exists on disk as a *path*. A directory named `foo@1.0.0/` in
  the DSH process's working directory, with any manifest inside it, decided which package was
  installed, booted, and written into `compatibility.json`. Rehearsing a package the user never had
  and exempting it is exactly the failure 2.0.0 claimed to remove.

  The identity now travels beside the spec (`pluginName`/`pluginVersion`, plus a `registryOnly` flag
  that forbids treating a spec as a path at all), so nothing downstream re-derives a package name
  from a string a caller chose.
- **A chunked request could skip the content-type requirement.** The "is there a body?" test read
  `content-length`; a chunked request has none, so it was treated as empty and the guard waved it
  through. Only an explicit `0`, or no body framing at all, counts as empty now.
- **`GET /repair` was outside the status guard.** The write guard deliberately lets read methods
  through, which left the dry-run scan reachable by a same-site page holding the cookie. It now goes
  through `checkStatusRequest` like `/status` does.
- `disable` / `enable` accepted any string as a plugin name and wrote it into the profile's patch
  layer. Inside the loopback boundary that is only a denial of service, but the name is validated now.

### Fixed

- **Host discovery was never told which version it was looking for.** 2.0.0 made
  `discoverDshDirectory` skip candidates whose manifest reports another version, but the rescue route
  and the CLI both called it without a version — so the check was dead code on the paths that matter,
  and a cached host from a previous release was used. The UI then said "this can be saved"
  (`canApply: true`) while `apply` refused forever with `inconclusive`, because `rescuePlugin`'s own
  host-version assertion caught the mismatch. Users upgrading from 1.x could not get out of that
  state. Both call sites now pass the running version.
- **The activation assertion could be satisfied by a neighbour.** It matched entry ids by substring,
  so with `dsh-x` under test an activated `dsh-x-ui` entry counted as proof, and a plugin that was
  disabled or absent passed. Matching is now exact on the package name and the entry id, and *every*
  entry carrying that name has to be active.

### Changed

- `scripts/http-smoke.js` now mounts the real `registerRepairRoute` / `registerRescueRoute` instead of
  calling the handlers directly. Previously its rescue cases bypassed the route's guard and key check
  entirely, so three "passes" asserted nothing. It now also covers the rescue route's negative cases
  and a chunked body: 16 checks.
- The dead `RESCUE_KEY` export is gone. It was never read, and its comment claimed the browser
  receives it.
- `test/loopback-peer.test.js` and `test/identity-and-activation.test.js` cover the four findings,
  including a real socket whose peer address is not loopback.

### Documentation

- `SECURITY.md` said remote attackers "were never able to reach these routes". That was true for
  cross-origin pages, but not for a host bound to a LAN address. It now states the peer requirement
  and the LAN case explicitly.

277 tests (16 new), 276 pass, 1 platform skip. Plus 16 checks over a real HTTP socket against the
real route registration.
## 2.1.0 (2026-11-03)

### Added

- **The plugin checks whether it is current, every time DSH opens.** A health tool that is itself out
  of date is worse than useless: it tells you your plugins need attention while quietly missing the
  fix that was released for the checker. The check is fired and forgotten when the plugin loads —
  nothing about DSH startup waits for it — and the result rides along with the status snapshot the
  panel already polls, so the answer is there before you open the section.

  It stays quiet by design. One request per boot, then at most one every six hours, and it only
  speaks up when there is actually something newer, along with the exact command
  (`dsh plugin --profile <profile> add dsh-plugin-health@2.1.0`). An "up to date" banner on every
  visit would train people to ignore the strip where a real notice has to appear.

  A check that fails is recorded as a failure, never as "you are current" — the two statements are
  different and only one of them is true. `DSH_PLUGIN_HEALTH_NO_UPDATE=1` turns the automatic check
  off entirely, for anyone who does not want a health tool making outbound requests.

- **Two new controls in the panel header.** `检查更新` / `Check for updates` asks the registry again on
  demand, because the boot-time check is deliberately silent. `浏览全部插件健康状况` /
  `Browse all plugin health` opens the public compatibility table — 4,389 plugins across two host
  versions — in the system browser, which is the most useful thing this project publishes when
  nothing is wrong on your own machine. It is a real anchor with `target="_blank"`, not a click
  handler, so the desktop shell hands it to the system browser rather than trying to render it
  inside the settings pane.

### Security

- The new `POST /plugins/dsh-plugin-health/update` route sits behind the same fence as every other
  write route — loopback host, JSON content type, matching `Origin`, non-cross-site `Sec-Fetch-Site`,
  constant-time control key — rather than getting its own. It is the only control in the package that
  reaches the network on its own, so a page on another local port must not be able to trigger it.
  The guard was extracted into one `authorize()` shared by both routes, so they cannot drift.

- The control-key comparison now works on SHA-256 digests. It compared UTF-16 lengths and then bytes,
  so 48 non-ASCII characters produced 96 bytes and `timingSafeEqual` threw
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` from inside an uncaught handler.

### Changed

- `registerRescueRoute` now extracts the host check, the write guards and the key comparison into one
  shared `authorize()`, so the two write routes cannot drift apart.

261 tests (23 new), 260 pass, 1 platform skip. Plus 11 checks over a real HTTP socket
(`scripts/http-smoke.js`) and 8 against the real route registration (`test/update-route.test.js`).
## 2.0.0 (2026-11-03)

Two independent reviews of 1.5.0 found that several guarantees this tool advertises did not actually
hold. This release makes them hold. It is a major version because three behaviour changes are breaking
for anything that drives the loopback routes directly: writes now require `application/json`, the
rescue actions refuse plugins that are not installed, and a damaged `compatibility.json` is refused
rather than rewritten.

### Security

- **Cross-site pages could drive every write route.** Cookies ignore the port, so a page served from
  any other `127.0.0.1:<port>` — a dev server, a notebook, a preview — was same-site with the DSH
  origin and carried the control cookie without ever reading it. `SameSite=Strict` does not stop that,
  and nothing checked `Content-Type` or `Origin`, so a `text/plain` POST skipped the CORS preflight.
  Writes now require `application/json`, an `Origin` matching the request's `Host`, and a
  `Sec-Fetch-Site` that is not cross-site (`src/ui/guard.js`).
- **The status route handed the key to any page that asked.** The `Set-Cookie` header is readable by
  any local process, which contradicts what the code comment claimed. The comment now says what is
  true — `HttpOnly` stops page script, not a local process — and the route refuses to seed the cookie
  for a cross-site request. `SECURITY.md` states the boundary it always meant: loopback itself.
- **A request body could name any package to install and run.** `rehearse` and `apply` accepted
  `plugin` and `version` verbatim, so `x@npm:evil`, `/tmp/pwn`, or a traversal path installed and
  booted something the user never had, with their environment. Both now require the plugin to be
  present in the profile at exactly that version, which removes the whole class.
- **The control-key comparison could be made to throw.** It compared UTF-16 lengths and then bytes, so
  48 non-ASCII characters produced 96 bytes and `timingSafeEqual` raised
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` inside an uncaught handler. Comparison now works on SHA-256
  digests, so any presented string is safe.
- **Action and workflow inputs were interpolated into shell script.** `${{ inputs.plugins }}` and
  friends went straight into `action.yml` and `matrix-review.yml`, where a caller-supplied branch name
  or PR title would execute on a runner holding `pull-requests: write`. Inputs now arrive through
  `env:`. `action.yml` also wrote its outputs after a command that exits non-zero under `--fail-on`,
  so callers got an empty matrix path exactly when the matrix mattered; outputs are written first and
  the exit code honoured last.
- `matrix-review.yml` defaulted `toolVersion` to `0.1.5`, a release from before the advisory. Anyone
  who did not override it got a build with the known issues still in it.

### Fixed — the rescue guarantee

The product rests on "we do not grant an exemption unless we have proven the plugin boots". Four paths
broke that:

- **The rehearsal could boot a different host than the one being exempted.** Downloaded hosts were
  cached in one unversioned directory, so after a host upgrade the rehearsal proved the plugin on the
  previous line while `compatibility.json` recorded the new one. The cache is now keyed by version,
  and `rescuePlugin` refuses to grant when `report.hostVersion !== runtimeVersion`. (Discovery was
  also taught to skip candidates whose manifest reports another version, but its callers did not
  pass a version, so that half only took effect in 2.1.1.)
- **"runs" ignored timeout, orphaned processes and non-zero exit.** It read `details.ok` alone, which
  only reports what the worker saw; the parent's `report.ok` and `runtime.ok` also go false on those
  failures. All three now have to hold.
- **Activation was checked for the profile, not for the plugin.** `verifyActivation` asserted every
  entry it could see had activated — a plugin that never got mounted simply was not in the list. It
  now also requires the plugin under test to be present and active.

### Fixed — the repair path

- **`compatibility.json` was replaced when it could not be read.** `readExemptions` returned `{}` on
  any parse error and the write path used it, so a truncated file — which this tool's own non-atomic
  write could cause — was replaced by a single entry. Reads for writing are now strict, unknown keys
  are preserved, and the file is written through a temp file with a backup.
- **`cordis.patch.yml` lost every comment.** `parse` + `stringify` drops them, while the docs promise
  they survive. Appends and removals now apply to the parsed document, so comments stay.
- **The tool's own backup was reported as stale residue** and offered for quarantine, which would have
  destroyed the recovery copy.
- **Undo across two host versions left an exemption behind.** Restoring a snapshot resurrected the
  version the previous undo had just removed; it now removes only the version the entry granted.
- **A plugin the user switched off kept being reported as incompatible**, and the panel offered the
  same fix again.
- **The rescue routes did not invalidate the status cache**, so the UI reloaded a snapshot predating
  the action it had just taken.
- **A backup that could not be written was swallowed**; the write now fails instead of replacing the
  only copy.

### Fixed — output quality

- **Generated issue text suggested a range that still rejected the host.** `ceilingFor` hard-coded the
  major version as `0`, so a 1.x host produced an empty range, and suggestions were never checked
  against the running version at all. Every suggestion is now verified with `semver.satisfies` and
  admits the exact version when the derived ceiling falls short.
- **The AI brief told the agent "the boot test says the code is fine" when no test had run.** The UI
  sends `rehearsalVerdict`; the route read `body.rehearsal`, so every brief fell into the `not-run`
  branch — and that branch claimed a passing boot. Both are fixed, and the `not-run` branch now says
  plainly that nothing has been tested.
- **Downloading a rehearsal host never worked on Windows.** Node refuses to spawn `.cmd` without a
  shell since the CVE-2024-27980 fix, so the desktop path — the one case the feature exists for —
  always failed. It now runs `npm-cli.js` with the current Node binary.

### Changed

- `README.zh.md` moved to `docs/README.zh.md`; both files carry a language switcher. npm filled its
  `readme` field from whichever file `readdir` returned first, which is arbitrary on Linux, so the
  package page showed the Chinese README and could have flipped without warning.

231 tests, 231 pass, 1 platform skip.
## 1.7.0 (2026-11-03)

### Changed

- **`README.zh.md` moved to `docs/README.zh.md`.** npm builds the packument's `readme` field from
  whichever readme `readdir` returns first in the package root, and that order is arbitrary on
  Linux — which is where releases are published. The result: the package page has been showing the
  Chinese README to everyone, and could flip to English on any future release without anyone
  noticing. One candidate in the root makes it deterministic.

  Both files now carry a language switcher at the top, using absolute URLs so the links work from
  npm as well as from the repository.

  Tests now assert that the package root holds exactly one readme, and that the two link to each
  other.

200 tests (2 new), 200 pass, 1 platform skip.

## 1.6.2 (2026-11-03)

### Fixed

- **The screenshots did not appear on npm.** They were referenced as `docs/images/…`, which the
  repository page resolves but npm cannot: it renders the README outside the repository, so the path
  resolves against npmjs.com and 404s. npm is where most people first meet the package, and it was
  showing a wall of broken images. Paths are now absolute.

  A test now fails on any relative image path in either README, and separately checks that every
  referenced screenshot exists and that `README.zh.md` does not fall back to English ones.

206 tests (7 new), 206 pass, 1 platform skip.

## 1.6.1 (2026-11-03)

### Fixed

- **The README screenshots showed a product that no longer exists.** Both images dated from before
  1.0.2 rebuilt the sidebar chip and the rescue flow replaced the dry-run dialog — so the page
  advertised a "repair plan" that had been gone for a week.

  They are now generated from the real component tree by `scripts/build-screenshots.js`. The
  section draws itself entirely with inline style objects and literal colours rather than the host
  stylesheet, so a faithful DOM can be rebuilt outside DSH with only the React runtime stubbed. Three
  states are captured — a rejected plugin with its check button, an exemption in effect with its
  revoke button, and the sidebar chip — each in English and Chinese, because `README.zh.md` no
  longer points at English screenshots.

  Regenerating is one command; the images are no longer a manual artefact that silently rots.

- Three images that nothing referenced were deleted rather than left to drift further
  (`settings-repair-plan.png`, `settings-repair-done.png`, `settings-plugin-health.png`).

199 tests, 199 pass, 1 platform skip.

## 1.6.0 (2026-11-03)

### Added

- **The compatibility page switches between English and Chinese.** A toggle in the top corner; the
  choice persists in localStorage, and a first visit without a stored choice follows the browser
  language. The 23 categories the catalog actually uses are translated too (ui → 界面, session →
  会话, …), because a Chinese reader filtering by a raw English slug is the same as no filter.

  English is what ships in the markup, so a crawler and the first paint both get real text; the
  Chinese dictionary is inlined beside it and swapped in place. Every visible string is tagged with
  data-i18n, and anything interpolating a number keeps that number in a data attribute — switching
  language never re-renders or re-fetches the table.

### Fixed

- A data-i18n key with no dictionary entry rendered the key itself: the page header briefly read
  80 tallyStamp × 2 个宿主版本. Comparing the two dictionaries could not catch it, since both
  simply lacked the key. A test now scans the markup for every key it asks for and asserts each one
  resolves in both languages.

189 tests (6 new), 189 pass, 1 platform skip.

## 1.5.0 (2026-11-03)

### Added

- **The compatibility page opens with its own numbers.** Three cells above the table: how many
  plugins were checked, how many load on every host, how many are rejected by at least one. A reader
  landing on a table of four thousand rows previously had to scroll and count to learn whether the
  situation was fine or bad.

  "Healthy" means accepted by *every* host column, not just the newest — a plugin that loads on rc.5
  but not on 
ext is a warning, not a pass. A plugin whose check errored is counted in neither
  column rather than being quietly promoted to healthy.

- **A "Where this comes from" note in the footer**, because the scope was easy to misread: the list
  is the awesome-dsh-plugin catalog filtered to npm-published entries, a GitHub-only plugin cannot be
  checked and is not counted, and every row is a comparison of declared ranges against the column
  headers — no plugin code runs, nothing is installed. That is why a tick means "the installer accepts
  it" rather than "it works".

### Fixed

- The per-host summary rendered each version as `0.2.1-RC.5` on its own line: a strong rule meant
  for the section label also matched the labels inside the list.

189 tests (4 new), 189 pass, 1 platform skip.

## 1.4.0 (2026-11-03)

### Added

- **The compatibility page gained a category, a release date, and the filters that make a
  four-thousand-row table usable.** A category pill per row, taken from the community catalog (the
  registry has no such field), with a dropdown to filter by it; the publish date of the version shown,
  because "rejected" reads differently on something released last week and something untouched since
  two host lines ago; and sortable Plugin / Released headers. Host columns are deliberately not
  sortable — "how many hosts reject this" is what people actually mean, and that is the existing
  filter.

- `matrix --catalog <file|url>` supplies the categories. Without it the page still renders; rows
  simply read `uncategorized` rather than blank, so an empty column cannot be mistaken for "no
  categories exist".

- `matrix.json` rows now carry `publishedAt` when the registry reports one.

189 tests (4 new), 189 pass, 1 platform skip.

## 1.3.0 (2026-11-03)

### Added

- **A public compatibility page.** `matrix` now writes a standalone `index.html` next to its
  JSON: one row per plugin, one column per host version, a name filter and an "only incompatible"
  toggle, all in a single self-contained file with no external requests. It states plainly that a
  tick means the installer will accept the plugin, not that the plugin works.
- **The daily build now scans the whole catalog.** It previously checked the six plugins hard-coded
  in `examples/plugins.txt` — a smoke test dressed as data. It now takes every npm-published
  plugin from the community catalog (4,389 at the time of writing) and publishes the result to
  `/compat/`, linked from the index landing page.

  The run costs about 20 minutes, because it makes one registry lookup per plugin. That is the price
  of covering the catalogue instead of a sample.

- The compatibility page and the index both deploy from one workflow, so a single job owns the Pages
  site and they cannot overwrite each other's `index.html`.

185 tests (9 new), 185 pass, 1 platform skip.

## 1.2.1 (2026-11-03)

### Fixed

- **1.2.0 shipped both READMEs with corrupted text.** Every em dash, arrow and Chinese character in
  the paragraphs that release rewrote had been mangled into mojibake — the em dashes in the English
  file, and the entire body of the Chinese one. The cause was round-tripping UTF-8 through a shell
  that re-encoded it; the rewrite is now done in a script that reads and writes UTF-8 directly, and a
  check for the mojibake sequences runs as part of it.

  Nothing functional was affected — the package, the CLI and the Action were untouched. Only the
  rendered documentation was wrong.

### Added

The three audience items 1.2.0 promised but did not deliver:

- **"No terminal needed"** near the install line, so a user who will never open a shell is not
  turned away by the first block of commands.
- **A batch-check example** (\doctor --profile\) showing what a healthy-ish profile looks like, for
  people who prefer a shell to a settings page.
- **A section explaining what "exempt temporarily" means** — gate, not support; host-version
  specific; how to undo it — instead of leaving it scattered across the page.

176 tests, 176 pass, 1 platform skip.

## 1.2.0 (2026-11-03)

No behaviour changes. This release is about being findable: the tool worked, but the three things
that make it useful to people other than the person who installed it were buried past line 390 of a
500-line README.

### Changed

- **The README is organised by who you are.** A routing table at the top sends users whose plugins
  broke, plugin authors, plugin-market builders and security reviewers to their own section. The
  opening paragraph now describes the problem ("DSH updated, your plugins stopped loading") instead
  of the architecture.
- **The GitHub Action moved from line 392 to line 111** — plugin authors are the audience with the
  most to gain and the least reason to scroll. The section now covers the `pull-requests: write`
  permission the comment needs (previously omitted, so a copy-paste failed), the reusable-workflow
  form, failure thresholds, and badge output.
- **The plugin index is documented as something you use**, not just something we publish: the
  format-1 URL, how to add it as a source inside DSH, how to build your own, and what the health
  score does and does not mean.
- **A Security section sits near the top** with the advisory and one sentence of trust boundary,
  instead of a blockquote inside "Safety boundaries".

### Fixed

- `action.yml` had no `branding` block, which is required before an Action can be published to
  the GitHub Marketplace, and no outputs. It now has both, plus outputs for the JSON path, the
  markdown path, and the incompatibility count.
- The reusable-workflow example in the README pinned `@v0.1.5`.
- `publish-index.yml` hard-coded the host version label to `0.2.1-rc.2`. Every index built since
  rc.3 has been labelled with a stale host, silently mislabelling 300 plugins. The label is now
  resolved from npm at build time unless the caller pins one.

176 tests, 176 pass, 1 platform skip.

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
