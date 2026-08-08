# Migration guide

This guide covers upgrading within the 1.x line and from 0.8/0.9. The 1.0
release stabilizes the public configuration schema, the audit schema, and the
OpenCode 1.x adapter contract. 1.1 adds optional fail-closed escalation without
changing defaults.

## Upgrade to 1.1

On upgrade from 1.0:

- **Default behavior stays interactive.** `escalationMode` defaults to
  `manual`, so uncertainty still escalates to a human exactly as in 1.0.
- **Approvals no longer annotate tool results.** Allow executes with a silent
  `once` reply; the primary agent only sees the real tool output. Denial still
  returns a short actionable reason. Rationale remains in audit, TUI, and debug
  logs. `annotateToolResult` stays exported as a deprecated no-op for 1.x
  compatibility.
- **Audit records gain optional fields** `reviewerOutcome` and
  `escalationDisposition`. `schemaVersion` remains `2` (additive). Old readers
  ignore the new fields.
- **`riskPolicy.onInvalidDecision` / `onReviewerFailure` now take effect.**
  They default to `manual` (unchanged). Set either to `deny` to harden only
  that failure class, or set `escalationMode: "deny"` for global fail-closed.
- **Structured decision schema stays at version 2.** Only the system prompt
  version moves to `2.1.0` (ACTION_PURPOSE guidance).

### Enabling autonomous / fail-closed mode

```jsonc
// ~/.config/opencode/permission-reviewer.jsonc  (global — do not commit deny
// into a shared repository config unless the whole team wants fail-closed)
{
  "escalationMode": "deny",
}
```

| Mode                     | Config                     | Behavior                                   |
| ------------------------ | -------------------------- | ------------------------------------------ |
| Interactive (default)    | `escalationMode: "manual"` | escalate → human                           |
| Autonomous / fail-closed | `escalationMode: "deny"`   | escalate → reject with the original reason |

Project config may harden `manual` → `deny` but cannot relax a trusted
`deny` back to `manual`.

## Upgrade behavior (existing users from 0.8/0.9)

On upgrade, your existing setup keeps working:

- **Inline plugin options remain valid.** The options you already have in
  `opencode.json` and `tui.json` (`model`, `variant`, `timeoutMs`,
  `confidenceThreshold`, …) are still accepted and keep their meaning.
- **The risk matrix keeps its conservative default.** Critical risk is never
  auto-approved, and the escalation gates are unchanged.
- **Agent-aware evidence is enabled automatically.** You do not need to
  configure actor resolution — it runs by default and degrades safely to
  "unknown" when it cannot resolve an actor.
- **Actor policy starts in `observe`.** The declarative policy engine ships
  with an empty rule set and does not change any decision in observe mode. It
  records a policy trace in the audit for you to inspect before enabling
  `enforce`.
- **The raw reply fallback remains available.** On OpenCode 1.18.x the
  permission reply is sent through the authenticated raw transport (the only
  reachable path today). The public-SDK reply chain is probed at startup and
  will be used automatically if a host exposes it.
- **Old audit fields remain readable.** `schemaVersion: 2` records are
  additive over v1 — report tooling that reads the older shape continues to
  work. Missing `schemaVersion` is treated as `1`.
- **The TUI overlay ships as raw TSX.** If you were loading a prebundled
  `dist/tui.js` from an older checkout, switch to the `./tui` export which now
  points at `dist/tui/tui.tsx`.

## What is new since 0.8

If you are coming from 0.8 or earlier, review the
[`CHANGELOG`](../CHANGELOG.md) entries for 0.9.0 and the current release. The
headline changes:

- **Reviewer decision schema v2** — decisions must carry `version: 2` and
  declare `scope_alignment` and `evidence_completeness`. A model output that
  omits the version is rejected and routed to manual review, so a model that
  does not follow the v2 schema never produces an automatic decision.
- **Layered configuration** — global, project, and inline options now merge
  with a safety trust boundary. See
  [Configuration layering](../README.md#all-configuration-options).
- **Declarative policy engine** — optional rule-based routing in `observe` or
  `enforce` mode. See the [Policy reference](./policy-reference.md).
- **Audit schema v2** — richer records with actor, capability, and policy-trace
  snapshots.
- **Isolated reply transport** — the permission reply is sent through a
  dedicated module with a documented fallback chain.

## Enabling enforcement

The recommended rollout from observe to enforce:

1. **Collect actor-aware audits** for a representative period — run normally in
   the default `observe` mode.
2. **Run `audit report`** to summarize the trail:
   ```bash
   opencode-permission-reviewer audit report
   ```
3. **Inspect unknown actors and false positives** — the report flags records
   with `identityCompleteness: "unknown"` and missing required fields.
4. **Configure explicit actor mappings** if you want a named agent to receive a
   profile (e.g. a read-only validator). Add them to global config only (a
   project config cannot grant profiles):
   ```jsonc
   // ~/.config/opencode/permission-reviewer.jsonc
   {
     "actorProfiles": { "my-validator-agent": "read-only" },
   }
   ```
5. **Run `explain`** on representative requests to dry-run the capability and
   policy output before going live:
   ```bash
   opencode-permission-reviewer explain --command 'bun test'
   ```
6. **Switch the policy mode to `enforce`** in global or inline config. In
   enforce mode, `manual` and `deny` policy routes skip the LLM entirely. The
   emergency brake always runs first and is never weakened by rules.

## Rollback

To roll back to a previous version:

- **Preserve the previous package version.** If you installed from npm, pin the
  old version in your dependency manifest. If you load from a checkout, keep the
  old checkout or tag.
- **`init` creates config backups.** The installer writes `.bak-<timestamp>`
  copies before modifying your `opencode.json` / `tui.json`; use them to
  restore the previous configuration.
- **Global config supports disabling actor enforcement.** Set
  `enforcementMode: "observe"` (or remove the policy rules) to return to
  LLM-only decisions without uninstalling.
- **Compatibility exports remain.** The `./server` and `./cli` export paths are
  stable for the 1.x line.
- **Audit schema includes a version.** Old readers ignore additive v2 fields, so
  mixed-version audit files are safe to consume.

See the [Compatibility reference](./compatibility.md) for the full version
matrix and support policy.
