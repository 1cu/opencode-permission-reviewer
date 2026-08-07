# Compatibility and support policy

## Supported versions

| Component             | Supported      | Notes                                                        |
| --------------------- | -------------- | ------------------------------------------------------------ |
| OpenCode              | `>=1.18.11 <2` | Declared in `engines.opencode`; verified with **1.18.15**    |
| `@opencode-ai/plugin` | `>=1.18.11 <2` | Peer dependency for the server transport                     |
| Bun                   | `>=1.3.0`      | Declared in `engines.bun`; CI runs **1.3.0** and **1.3.5**   |
| TUI overlay           | OpenCode V1    | Needs the host Solid/OpenTUI plugin pipeline (raw TSX entry) |
| OS                    | macOS / Linux  | On Windows, SSH/Git enrichment degrade to fail-safe manual   |

## Versioning

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- **Major** (1.x → 2.x): breaking changes to the public configuration schema,
  the audit schema, or the supported OpenCode adapter contract.
- **Minor** (1.0 → 1.1): new features and configuration options, backward
  compatible.
- **Patch** (1.0.0 → 1.0.1): bug fixes and safety hardening, backward
  compatible.

The **audit schema** is versioned via `schemaVersion` and is additive within a
major line — new fields are added, existing fields keep their meaning. Report
tooling should tolerate additive fields.

## OpenCode version support

- **Minimum:** `1.18.11` — the first release with the adapter surface the
  reply transport relies on.
- **Current/verified:** `1.18.15` — the version tested in CI and live smokes.
- **Maximum:** `<2` — OpenCode v2-generation hosts are detected and refused at
  startup until their reply contract is verified. If startup fails with
  _"Detected an OpenCode v2…"_, run a 1.18.x host.

Run `opencode-permission-reviewer doctor` to compare installed versions
against the ranges above.

## Bun version support

- **Minimum:** `1.3.0` — CI runs against this version to catch drift.
- **Pinned/current:** `1.3.5`.

## Operating systems

- **macOS / Linux:** full enrichment (SSH, local scripts, Git).
- **Windows:** SSH and Git enrichment degrade gracefully toward fail-safe
  manual review. The reviewer and policy engine work normally; only the
  read-only enrichment providers are affected.

## Deprecation policy

A feature or configuration option will be deprecated with a `CHANGELOG` entry
and a runtime warning (where feasible) for at least one minor release before
removal in a major release.

## Support policy

- The latest minor release of the current major line receives bug and safety
  fixes.
- Security fixes are backported to the latest minor of the current major line.
- See [`SECURITY.md`](../SECURITY.md) for the vulnerability disclosure process.
