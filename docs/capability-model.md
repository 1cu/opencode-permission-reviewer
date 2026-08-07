# Capability model reference

Every `bash` permission request is statically analyzed to produce a
`CapabilityAssessment`: a structured description of what the command can do.
This assessment feeds the declarative policy engine and is attached to the
reviewer prompt and the audit record.

Static analysis is **best-effort**. When parsing fails, the assessment is
`undefined` and the review proceeds — absence is non-fatal.

## The assessment object

| Field                            | Values                  | Meaning                                                                   |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `actionClass`                    | `CapabilityActionClass` | The dominant capability label (see below)                                 |
| `summary`                        | `string`                | Human-readable summary of the detected surface                            |
| `executesCode`                   | `boolean \| "unknown"`  | Runs an interpreter/runtime (sh, python, node, bun, …)                    |
| `executesRepositoryCode`         | `boolean \| "unknown"`  | Runs code that lives in the repo                                          |
| `createsAdHocCode`               | `boolean \| "unknown"`  | Runs ad-hoc code (heredoc / inline)                                       |
| `invokesExistingTestRunner`      | `boolean \| "unknown"`  | Invokes a known test runner (pytest, jest, `bun test`, …)                 |
| `invokesPackageLifecycleScripts` | `boolean \| "unknown"`  | Runs a package manager that may execute lifecycle scripts                 |
| `writeEffects.temporaryWrite`    | `boolean \| "unknown"`  | Writes to `/tmp`, `/var/tmp`, `/dev/shm`, `/dev/null`                     |
| `writeEffects.workspaceWrite`    | `boolean \| "unknown"`  | Writes inside the working directory / worktree                            |
| `writeEffects.externalWrite`     | `boolean \| "unknown"`  | Writes outside the workspace (absolute path, `git push`)                  |
| `writeEffects.deletion`          | `boolean \| "unknown"`  | Deletes files (rm, rmdir, shred, truncate)                                |
| `network.observed`               | `boolean \| "unknown"`  | A network client is present (curl, wget, nc, ssh, …)                      |
| `network.destinations`           | `string[]`              | Literal hosts/URLs observed in the command                                |
| `process.childProcesses`         | `boolean \| "unknown"`  | Spawns child processes                                                    |
| `process.persistence`            | `boolean \| "unknown"`  | Persistence (nohup, setsid, at/cron, service managers)                    |
| `process.privilegeEscalation`    | `boolean \| "unknown"`  | Privilege escalation (sudo, doas, pkexec, su, …)                          |
| `remote.enabled`                 | `boolean \| "unknown"`  | Remote operation enabled (ssh, mosh, autossh)                             |
| `remote.mutationHint`            | `boolean \| "unknown"`  | The remote command appears to mutate (git mutation subcommand, `rm` tail) |
| `git.observed`                   | `boolean \| "unknown"`  | `git` is present                                                          |
| `git.possible`                   | `boolean \| "unknown"`  | Git mutation is possible                                                  |
| `parserCompleteness`             | `ParserCompleteness`    | How complete the analysis was (see below)                                 |
| `analysisWarnings`               | `string[]`              | Notes about analysis limits                                               |

Every capability flag is **tri-state**: `true`, `false`, or `"unknown"`. When
something is not detected, the value is `"unknown"` (never `false`). This
honesty is important — a policy rule with `writesWorkspace: true` does **not**
match an `"unknown"` fact.

## Provenance

Each fact carries provenance via `Provenanced<T>`:

```ts
interface Provenanced<T> {
  value: T
  source: "static-analysis" | "heuristic" | "global-config" | …
  confidence: "confirmed" | "high" | "medium" | "low" | "unknown"
}
```

The analyzer produces facts via two factories:

- **`staticFact`** → `source: "static-analysis"`, `confidence: "high"` (or
  `"unknown"` if the value is unknown).
- **`heuristicFact`** → `source: "heuristic"`, `confidence: "medium"`.

## `actionClass` values

The dominant capability label (one value):

`read-only`, `workspace-write`, `temporary-write`, `external-write`,
`destruction`, `code-execution`, `package-management`, `git-mutation`,
`network`, `remote-operation`, `service-management`, `persistence`,
`privilege-escalation`, `unknown`

The dominant class is the first **specific** detection that wins in the main
analysis pass (e.g. `ssh` head → `remote-operation`; network client →
`network`; service manager → `service-management`). If none fires, a priority
resolution picks the most significant class: `destruction` > `git-mutation` >
`external-write` > `code-execution` > `package-management` > `persistence` >
`privilege-escalation` > `temporary-write` > `workspace-write` > `read-only`.

Note: the dominant class is a summary — individual flags remain `true` even
when the class is different. For example, `rm -rf x && curl …` has class
`destruction` but `network.observed: true`.

## `parserCompleteness`

| Value                         | When                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `complete-for-supported-form` | No dynamic constructs (no variables, globs, substitutions, or dynamic heredoc bodies). Everything the analyzer supports was analyzed.                                          |
| `partial`                     | Dynamic constructs are present (`$VAR`, `${…}`, globs `*`/`?`, process substitution), but no command substitution (`$(…)`, backticks) and no dynamic heredoc bodies.           |
| `opaque`                      | Command substitution in the sanitized command, or at least one heredoc with a dynamic body (`<<EOF` without quotes containing `$`). The analyzer cannot resolve what executes. |

## How commands are parsed

### Wrapper peeling

Before analysis, transparent wrappers and their value-options are consumed to
find the real executable:

- **Privilege wrappers** (`sudo`, `doas`, `pkexec`, `su`, `runuser`, `super`,
  `setpriv`, `setcap`, `capsh`) → set `privilegeEscalation: true`.
- **Transparent wrappers** (`env`, `command`, `nice`, `nohup`, `time`,
  `stdbuf`, `ionice`, `fakeroot`, `setsid`, `setpriv`, `unshare`, `run0`) →
  consumed with their options, then analysis continues on the next token.
- **Shell binaries** (`sh`, `bash`, `zsh`, `dash`, `ksh`, `ash`, `mksh`,
  `fish`) with `-c`/`--command` → the script is re-lexed and analyzed
  recursively (command-string destructuring).
- **SSH** → options and host are consumed; the remote command tail is re-lexed.
- **`busybox applet…`** / **`chroot root cmd…`** → recursion on the tail.

So `sudo sh -c 'python x.py'` produces both `privilegeEscalation: true` (from
the head) and `executesCode: true` (from the destructuring).

### Heredoc extraction

Heredoc bodies are extracted **before** lexing and replaced with a
`<HEREDOC:sha256:xxxxxxxx>` placeholder. Consequence: the lexer and analyzer
never see the heredoc body content — a destructive command inside a heredoc
does not mark `deletion`. The body is bounded to 4096 bytes; only its SHA-256
is used for identity, never the raw text.

### Compound commands

Compound commands (`a; b`, `a | b`, `a && b`) are split into effective
commands. Capabilities are **accumulated via OR** across all commands,
redirections, and heredocs in the chain. A single command in the chain that
touches network marks `network.observed: true` for the whole request.

## What the reviewer sees

The reviewer prompt receives a `CAPABILITY_ASSESSMENT` JSON section (after
`LOCAL_SESSION_CONTEXT`, before `EVIDENCE_COMPLETENESS`). Only the `.value` of
each fact is shown — provenance and confidence are omitted from the model's
view:

```jsonc
{
  "actionClass": "code-execution",
  "summary": "code execution, temporary write",
  "executesCode": true,
  "createsAdHocCode": "unknown",
  "writeEffects": {
    "temporaryWrite": true,
    "workspaceWrite": "unknown",
    "externalWrite": "unknown",
    "deletion": "unknown",
  },
  "network": { "observed": "unknown" },
  "process": { "childProcesses": true },
  "remote": { "enabled": "unknown" },
  "git": { "mutation": "unknown" },
  "parserCompleteness": "complete-for-supported-form",
}
```

## What the audit records

The audit record (`schemaVersion: 2`) stores an **additive capability
snapshot**. Flags appear only when their value is `true` (false/unknown are
omitted); `writeEffects` is always present (possibly `{}`):

```jsonc
"capability": {
  "actionClass": "code-execution",
  "summary": "…",
  "parserCompleteness": "complete-for-supported-form",
  "executesCode": true,
  "writeEffects": { "temporaryWrite": true },
  "networkObserved": true,
  "privilegeEscalation": true
}
```

Note the flattened names in the audit (`networkObserved`, `privilegeEscalation`,
`persistence`, `remoteEnabled`, `gitMutation`) which map from the nested
assessment object. `gitMutation` is fed by `git.possible`, not `git.observed`.

## Relationship to policy rules

The declarative policy engine matches conditions against capability `.value`
fields (positive-only: `=== true`). See the [Policy reference](./policy-reference.md)
for the full condition-to-fact mapping.

## Inspecting capability analysis

```bash
opencode-permission-reviewer explain --command 'rm -rf /tmp/scratch && curl https://example.invalid'
```

This dry-runs a command through the capability analyzer and policy engine,
printing the full `CapabilityAssessment` and policy trace as JSON. Actor
context is `undefined` in `explain` output (it runs without a live session).
