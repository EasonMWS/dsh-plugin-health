# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private
[Security Advisories](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/new)
for this repository, or contact the maintainer through the profile linked from the repository.

Include the version, the command or module affected, and a minimal reproduction.

## Published advisories

| Advisory | Severity | Affected | Fixed in |
| --- | --- | --- | --- |
| [GHSA-vj8q-543v-9hw5](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-vj8q-543v-9hw5) | High | `<= 1.0.3` | **1.1.0** |
| [GHSA-52w2-cq6j-xhg7](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-52w2-cq6j-xhg7) | High | `>= 1.1.0, < 2.0.0` | **2.0.0** |

Seven issues were found in a security test of 1.0.2, and fixed in 1.1.0. The reachable chain needed a
**local process**: the write routes' control key was returned by the unauthenticated `/status` endpoint,
so anything on the machine that could reach loopback could obtain it and then reach destructive
actions — a config wipe on a patch layer the tool could not parse, an arbitrary-path write through the
handoff directory, and code execution through a caller-supplied host directory or a non-semver host
spec.

See [GHSA-52w2-cq6j-xhg7](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-52w2-cq6j-xhg7).

**Two of those fixes were incomplete, and a second review of 1.5.0 found the gaps.** They are fixed in
2.0.0:

- moving the key from the response body into a cookie stopped page scripts from reading it, but it
  also removed the custom header whose presence had forced a CORS preflight. A page served from any
  other local port is *same-site*, so it carried the cookie without reading it and could drive every
  write route. Writes now require JSON, a matching `Origin` and a non-cross-site `Sec-Fetch-Site`;
- requiring an exact semver stopped a non-semver *host* spec, but the *plugin* spec still came
  straight from the request body, so `x@npm:evil` or a local path installed and booted something the
  user never had. The rescue actions now only act on an installed plugin at its installed version.

The same review found three ways to obtain an exemption without a passing rehearsal (a cached host
from a previous release, a verdict that ignored timeout and orphaned processes, and an activation check
that never asserted the plugin itself had loaded), plus a `compatibility.json` that was rewritten when
it failed to parse. All are fixed in 2.0.0.

The current route guards check loopback Host and peer addresses, reject conflicting browser Origin
and Fetch Metadata headers, and require JSON for nonempty writes. Requests without browser headers
can still come from local programs. These checks protect these HTTP routes; they do not constrain
code already running in DSH. Historical gaps are described above.

**A host bound to a LAN address was a different matter, and 2.1.1 fixes it.** Every route decided
"loopback only" from the `Host` header — which the client writes. With the web server listening on
`0.0.0.0` or a specific LAN address (the host supports both), another machine on the network could
send `Host: 127.0.0.1:<port>`, pass every check, read the control cookie from `/status`, and then
disable plugins or run a rescue. All four handlers now also require the **peer address** to be
loopback — the one part of a connection a client cannot choose. The `Host` check stays, because it is
what stops DNS rebinding.

If you bind the DSH web server to a non-loopback address, treat every plugin route as exposed to the
network and check that the host's own authentication is what you are relying on.

**If you run 1.0.3 or earlier, upgrade to 1.1.0.** The advisory carries the details.

## Scope

### Malware containment is not implemented

**Health cannot currently stop a malicious plugin from spreading, stealing data, or changing files.**
It diagnoses plugin compatibility, installation problems and observed activation failures. A passing
check means the checks described in the report passed during that trial; it does not mean the plugin
is safe. Malicious code can activate normally, behave differently later, or interfere with evidence
inside the process or account where it runs.

| Area | What Health currently does | What it does not enforce |
| --- | --- | --- |
| Files | Reads manifests/configuration; compares declared shared-write paths; makes explicitly requested repairs with backups | No file-access mediation, prevention of writes outside a workspace, protection of startup locations, or rollback of arbitrary plugin writes |
| Network | Its own status polling is local; update/report actions can contact their configured public services | No per-plugin network allowlist, connection blocking, or prevention of data exfiltration |
| Child processes | Startup trials have time limits and best-effort cleanup of their process trees | No general process-creation permission gate; Windows trials cannot detect every child left after its parent exits |
| Secrets | Report output omits selected configuration values and raw live error messages | No secret isolation from a running plugin; trials inherit the launching process environment and account permissions |
| Other plugins and Health itself | Reads the host Loader inventory and reports sampled failures and transitions | No isolation between plugins sharing a host process; no guarantee a hostile plugin cannot bypass, disable or falsify observation |
| Disable / safe mode | Writes configuration overlays to help restore normal loading | No guaranteed immediate termination of loaded code, no cleanup of persistence, and no malware removal |
| Repair quarantine | Moves damaged/residual items into an ordinary backup directory for recovery | No OS restriction on executing or accessing those files; this is not antivirus quarantine |
| Repair restore | Reverses supported, recorded Health repair operations when conflict checks pass | No undo of leaked data, arbitrary plugin changes, or system compromise |

The three UI modes change information density. They do not change operating-system permissions or
the trust level of plugins. The live view samples Loader state when status is requested; it does not
continuously intercept file, network or process operations.

### A startup trial is execution, not a safe way to open unknown software

`smoke`, combination checks and rescue rehearsals install and execute the selected plugin code.
They create a separate DSH data directory and launch a worker with the current account's permissions
and inherited environment. Health does not impose OS file, network or process restrictions on that
worker. The installation stage calls the host's package manager; Health does not impose its own
lifecycle-script prohibition on that stage. Host policy determines how installation scripts are
handled. Disabling scripts for Health's **self-update** is a different operation and does not make
startup trials safe.

The temporary directory protects against accidentally selecting the normal profile as the trial's
configuration. It does not prevent the tested code from reading or writing the normal profile or
other account-accessible paths. A timeout, failed trial or withheld version exemption does not imply
that no effects occurred. Logs and result files also share this account-level trust boundary.

Only use these trials for code you already trust. Unknown or suspected malicious software requires
a separately configured security environment with restricted files, credentials, networking and
process permissions. Health does not create or verify such an environment.

### What a future containment design would require

Containment must be enforced outside the untrusted plugin's execution context, before loading its
code. A proposed host design would place plugins in restricted workers and mediate file access,
network requests, process creation and secret delivery through a trusted permission service. It
would need to cover package installation and lifecycle hooks as well as activation and tool calls,
deny ungranted capabilities by default, track worker lifetimes, and record evidence outside workers'
write access. Shared state would need coordinated writes or transactions through that service.

Moving code into another process with the same unrestricted account is insufficient by itself.
JavaScript API wrappers, declarations and post-event observation are also insufficient when a plugin
can bypass them. OS-enforced restrictions and adversarial validation would be necessary before
describing a future version as containing hostile plugins. None of that containment is implemented
or claimed by this release.

### 3.0 beta hardening

- UI repair confirmation requires a one-use preview token, valid for five minutes and bound to the
  profile, proposed actions and target file metadata (plus content hashes for small regular files).
  New targets, edits, expired plans and replayed confirmations are refused with HTTP 409 until the
  user previews again. This narrows the preview-to-apply gap; it is not a filesystem transaction or a
  lock against another process changing files during the operation.
- All status variants and write routes validate a supplied `Origin` against the actual connection
  scheme, host, and port, alongside Fetch Metadata. TLS is determined from the socket, never from
  caller-supplied forwarding headers. HTTPS termination by a proxy is therefore not implicitly
  trusted. JSON responses use `nosniff` and `no-store`.
- Rescue action dispatch accepts only explicitly registered actions. Installed package identity
  must match both name and version, so an npm alias cannot cause rescue to download a different
  registry package. Request-supplied host hints must resolve inside the DSH home, match the running
  DSH version, and point to an executable inside that package. These checks constrain request input;
  they do not prove the authenticity of local files.
- Self-update disables package lifecycle scripts and preserves the profile's release-age policy.
  A policy refusal is reported as an installation failure rather than silently removing the policy.
- Reliability snapshots contain package metadata, fingerprints, configuration key names and
  declared resource paths. They exclude configuration values and raw runtime error messages.
  Names and paths may still identify a private project; review snapshots before sharing them.
  The live observer samples only when status is read and does not intercept filesystem or network
  activity. It cannot certify third-party plugin safety.

The scheme comparison and explicit action table are defense in depth. They are not evidence that
the previously guarded routes were remotely exploitable in a modern browser. The local-user and
same-origin plugin trust boundaries below still apply.

`dsh-plugin-health` is a local developer tool:

- `matrix` and `index` fetch public npm registry metadata and a public catalog; no credentials are
  sent.
- `doctor` reads the local DSH home only and sends nothing.
- `repair` is opt-in (`--apply`), defaults to a dry run, never deletes, and moves files into
  `<DSH_HOME>/.plugin-health/quarantine/` first. `cordis.patch.yml` is written atomically after a
  backup, and refused outright if it is not a YAML sequence this tool understands.
- The tool has no telemetry.
- `smoke` is opt-in and **executes the plugin being tested**, including package installation,
  in a fresh, retained `DSH_HOME`. It never targets an existing profile, but inherits the process
  environment and runs with the user's OS permissions; it is not a security sandbox. Its reports
  retain bounded installation/runtime logs, which should be reviewed before sharing.

### Trust boundaries, stated plainly

The write routes are reachable by any process that can reach the loopback interface. **The loopback
interface is the boundary.** If you run untrusted code on the same machine with the same user account,
it can call these routes. No key can change that: whatever the UI can present, a local process can
present too.

The control key narrows this in one direction only, and it is worth being precise about which:

- **Against a page on another origin** it works, and since 2.0.0 it works properly. Cookies ignore the
  port, so a page on any other `127.0.0.1:<port>` is *same-site* with the DSH origin and carries the
  cookie without ever reading it — `SameSite=Strict` does not help there. That is closed by requiring
  `Content-Type: application/json` on writes (which forces the CORS preflight), an `Origin` that
  matches the connection scheme, host and port, and a `Sec-Fetch-Site` that is not cross-site.
- **Against a local process** it does not work, and never did. `HttpOnly` stops page script from
  reading the cookie; it does not stop anything that speaks HTTP. A process that can issue
  `GET /plugins/dsh-plugin-health/status` can read `Set-Cookie` and replay it. Earlier releases
  claimed otherwise in a code comment; that comment was wrong and has been corrected.
- **Against same-origin plugins** it does not provide isolation. The status JSON includes a key
  fallback for hosts that do not forward cookies; code running in the DSH web origin can read it.
- **Against the request body** the key is now irrelevant for the dangerous action: `rehearse` and
  `apply` only act on a plugin that is already installed in the profile at exactly the stated version,
  so a caller cannot name a package to download and run.

What it cannot guarantee:

- a compatibility label, health score, or catalog listing is **not** a security review;
- DSH plugins run with the user's full permission — installing third-party plugins is a trust
  decision;
- a third-party marketplace index is unsigned; only add sources you trust.

## Supported versions

The latest minor release receives security fixes. The tool targets the currently published
`@deepseek-ai/dsh` prerelease line; compatibility data about other host versions is descriptive,
not a support commitment.
