# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private
[Security Advisories](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/new)
for this repository, or contact the maintainer through the profile linked from the repository.

Include the version, the command or module affected, and a minimal reproduction.

## Scope

`dsh-plugin-health` is a local developer tool:

- `matrix` and `index` fetch public npm registry metadata and a public catalog; no credentials are
  sent.
- `doctor` reads the local DSH home only and sends nothing.
- `repair` is opt-in (`--apply`), defaults to a dry run, never deletes, and moves files into
  `<DSH_HOME>/.plugin-health/quarantine/` first. `cordis.patch.yml` is edited textually after a
  backup.
- The tool has no telemetry.
- `smoke` is opt-in and **executes the plugin being tested**, including package installation,
  in a fresh, retained `DSH_HOME`. It never targets an existing profile, but inherits the process
  environment and runs with the user's OS permissions; it is not a security sandbox. Its reports
  retain bounded installation/runtime logs, which should be reviewed before sharing.

What it cannot guarantee:

- a compatibility label, health score, or catalog listing is **not** a security review;
- DSH plugins run with the user's full permission — installing third-party plugins is a trust
  decision;
- a third-party marketplace index is unsigned; only add sources you trust.

## Supported versions

The latest minor release receives security fixes. The tool targets the currently published
`@deepseek-ai/dsh` prerelease line; compatibility data about other host versions is descriptive,
not a support commitment.
