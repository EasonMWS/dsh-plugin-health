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

Cross-origin attackers were never able to reach these routes: the `Host` check stops DNS rebinding, and
every write needs a same-origin `Origin`, which a page has to send.

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
  matches the request's `Host`, and a `Sec-Fetch-Site` that is not cross-site.
- **Against a local process** it does not work, and never did. `HttpOnly` stops page script from
  reading the cookie; it does not stop anything that speaks HTTP. A process that can issue
  `GET /plugins/dsh-plugin-health/status` can read `Set-Cookie` and replay it. Earlier releases
  claimed otherwise in a code comment; that comment was wrong and has been corrected.
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
