# Threat model

This plugin is a **defense-in-depth aid**, not a complete sandbox. It adds a
second, tool-free model call between OpenCode's `ask` pause and the user's
keystroke. Understanding what it does and does not protect against is essential
for using it safely.

## What this plugin is

- A reviewer that runs on `ask`-classified permission requests only.
- `allow` continues, `deny` stays blocked — neither reaches the reviewer.
- A deterministic **emergency brake** rejects unmistakable root destruction and
  direct credential export before any model call.
- A second model session (tools disabled) reads bounded evidence and returns a
  JSON decision.
- Everything fails safe to manual review when anything is missing, broken, or
  untrusted.

## What this plugin is not

- It does **not** sandbox commands. Temporary write access is never represented
  as isolation.
- It does **not** replace OpenCode's permission system, your model provider's
  safety layers, or OS-level hygiene.
- It does **not** run a second classifier LLM in parallel — there is exactly
  one reviewer model call per request.
- It does **not** review OpenCode `allow` or override `deny`.

## Attack surfaces

### Prompt injection

The reviewer reads evidence that may contain adversarial content. Injection
sources include repository files, scripts, command strings, transcripts, tool
output, session titles, project configuration, and delegated subagent prompts.

Mitigations:

- **System-level reviewer instructions** — the reviewer prompt is built from a
  fixed system message; injected content is placed in clearly-delimited,
  untrusted evidence sections.
- **Explicit untrusted-evidence boundaries** — every evidence section is
  labeled as untrusted; the system prompt instructs the reviewer to verify
  signals against the exact command.
- **Credential redaction** — common credential formats are scrubbed from
  evidence before it reaches the reviewer's provider. See the
  [Capability and redaction](#credential-redaction) section below.
- **Provenance labels** — actor and lineage facts carry a `source` and
  `confidence` so the reviewer can weigh how trustworthy each signal is.

A determinedly adversarial agent may still attempt to mislead the reviewer.
The deterministic emergency brake and the untrusted-evidence framing mitigate
but cannot fully eliminate that risk.

### Credential exfiltration

The reviewer is a normal model invocation and may run on a **different**
provider than the primary agent. Anything the user pasted into the session — a
Bearer token, an AWS key, a private key, a password in a config — would
otherwise travel verbatim to that second provider.

Mitigations:

- **Always-on redaction.** PEM private keys (including ASCII-armored GPG secret
  keys), AWS access keys (`AKIA`/`ASIA`), GitHub tokens (`ghp_`/`gho_`/`ghs_`/
  `ghr_`/`ghu_`/`github_pat_`), OpenAI keys (`sk-proj-`/`sk-` excluding
  Anthropic), Anthropic keys (`sk-ant-`), Slack tokens, Google API keys,
  Stripe keys, GitLab/NVIDIA/Telegram tokens, JWTs, URL userinfo
  (`scheme://user:pass@host`), auth-scheme prefixes (`Bearer`/`Basic`/`Token`),
  cookie headers, authorization-style headers (`authorization`/
  `proxy-authorization`/`x-api-key`/`x-auth-token`), and generic credential
  assignments are replaced with `[REDACTED:type]` markers before the evidence
  reaches the model.
- **Remote commands stored as SHA-256** in the audit trail, never in plaintext.
- **Best-effort, lossy by design.** Redaction catches literal credential
  formats, not arbitrary prose secrets or shell variable expansions.

### Project-configuration tampering

A malicious repository could try to relax the plugin's safety invariants via
`.opencode/permission-reviewer.jsonc`.

Mitigations (the [trust boundary](#trust-boundary)):

- Project config **cannot** redirect or silence the audit trail (`auditPath`).
- Project config **cannot** grant `actorProfiles` (a repo cannot promote its
  own agent to `operator`).
- Project config **cannot** downgrade a global `enforcementMode: "enforce"` to
  `observe`.
- Project config **cannot** set `repositoryTrust: "trusted"` (a repo cannot
  self-declare trust).
- Project policy rules **combine** with trusted (global/inline) rules using
  most-restrictive resolution; a repo cannot erase a user's deny or manual
  rules by declaring an empty or narrower set.
- Project-sourced `allow` rules are **filtered out** before evaluation.

### Reviewer failure or manipulation

If the reviewer model is unavailable, returns invalid output, times out, or is
fooled by a prompt injection, the failure is safe:

- Invalid, low-confidence, or inconsistent output is escalated (or, when
  `escalationMode: "deny"` / the matching failure knob is set, rejected with
  rationale).
- Critical-risk actions cannot be approved, even if model output says `allow`.
- High-risk actions with low/unknown authorization, and medium-risk actions
  with unknown authorization, are deterministically escalated — the model
  cannot auto-approve them by labeling a contradictory combination.
- The emergency brake runs before the model and is never weakened by policy
  rules.
- A manual reply that arrives mid-review **supersedes** the automatic one (no
  double reply). Manual supersede is never converted by fail-closed disposition.
- Approvals do not write rationale into the primary agent context; only denials
  feed back a reason.

## Credential redaction

Redaction is applied at the evidence truncation boundary and to the reviewer
session title, so no copy of the evidence reaches the model unredacted. The
`[REDACTED:type]` marker preserves enough signal ("there was a credential here
of kind X") for the reviewer to reason about authorization without exposing the
value. The marker is stable (idempotent) thanks to negative-lookahead guards,
so a second redaction pass is a no-op.

Limitations (intentional): variables, globs, command substitutions, and
arbitrary prose secrets are not detected — only literal credential formats.

## Trust boundary

Configuration layers merge with a safety trust boundary. The effective order
is:

```
builtin defaults  ←  global (~/.config/opencode/permission-reviewer.jsonc)
                 ←  project (.opencode/permission-reviewer.jsonc)
                 ←  inline plugin options (later wins)
```

Fields that a repository must not control (`auditPath`, `actorProfiles`,
`enforcementMode` downgrade, `repositoryTrust` elevation) are clamped or
deleted from the project layer before merging. See the
[Actor resolution reference](./actor-resolution.md) and
[Policy reference](./policy-reference.md) for the downstream effects.

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md) for the private disclosure process. Do not
file a public issue for a security vulnerability.
