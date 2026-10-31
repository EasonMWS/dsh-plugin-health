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

Seven issues from an external review. The reachable chain needed a **local process**: the write
routes' control key was returned by the unauthenticated `/status` endpoint, so anything on the
machine that could reach loopback could obtain it and then reach destructive actions — a config
wipe on a patch layer the tool could not parse, an arbitrary-path write through the handoff
directory, and code execution through a caller-supplied host directory or a non-semver host spec.
Remote and cross-origin attackers were never able to reach these routes (host header check, and a
custom header forced a preflight).

**If you run 1.0.3 or earlier, upgrade to 1.1.0.** The advisory carries the details.

Thanks to the reviewer who found these and reported them privately.

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

The write routes are reachable by any process that can reach the loopback interface. The control
key delivered as an `HttpOnly; SameSite=Strict` cookie stops a *page* from another origin and keeps
the value away from page scripts, but it cannot distinguish the legitimate UI from another local
process — that distinction does not exist over a loopback HTTP connection. **The loopback interface
is the boundary.** If you run untrusted code on the same machine with the same user account, it can
call these routes.

What it cannot guarantee:

- a compatibility label, health score, or catalog listing is **not** a security review;
- DSH plugins run with the user's full permission — installing third-party plugins is a trust
  decision;
- a third-party marketplace index is unsigned; only add sources you trust.

## Supported versions

The latest minor release receives security fixes. The tool targets the currently published
`@deepseek-ai/dsh` prerelease line; compatibility data about other host versions is descriptive,
not a support commitment.
