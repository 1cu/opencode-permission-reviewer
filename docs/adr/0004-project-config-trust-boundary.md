# ADR 0004: Project configuration trust boundary

## Status

Accepted

## Context

Configuration is layered: builtin defaults, global
(`~/.config/opencode/permission-reviewer.jsonc`), project
(`.opencode/permission-reviewer.jsonc`), and inline plugin options. A
malicious repository could try to relax the plugin's safety invariants —
silence the audit trail, grant its own agent a high-privilege profile, or
declare itself trusted — via the project layer.

## Decision

The project layer operates inside a **trust boundary**. When merging, the
following fields are clamped or deleted from project config before it can
affect the effective configuration:

- **`auditPath`** — project config cannot redirect or silence the audit trail.
- **`actorProfiles`** — project config cannot grant profiles (deleted entirely
  from the project layer).
- **`enforcementMode`** — project config cannot downgrade a global `enforce`
  to `observe`.
- **`repositoryTrust`** — project config cannot set `"trusted"` (a repo cannot
  self-declare trust).
- **`policyRules`** — project rules **combine** with trusted (global/inline)
  rules using most-restrictive resolution; project-sourced `allow` rules are
  filtered out before evaluation.

Numeric/string options are also clamped to safe bounds at every layer.

## Consequences

- **Positive:** a cloned repository cannot weaken the user's safety
  configuration.
- **Positive:** the combination semantics (most-restrictive wins, project
  `allow` filtered) make the boundary composable — adding a global deny rule
  cannot be erased by the project declaring an empty or narrower set.
- **Negative:** users who legitimately want per-project policy relaxation must
  set it in global or inline config, not in the repo.
