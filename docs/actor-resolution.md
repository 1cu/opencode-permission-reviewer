# Actor resolution reference

The reviewer needs to know **who** is requesting a permission to weigh intent
and authorization. Actor resolution recovers the requesting agent's identity,
its session lineage, and the user's direct intent — all as labeled evidence
that degrades safely to "unknown" on any failure.

## What is resolved

For each `ask`-classified request, the resolver builds an `ActorContext`:

| Field                  | Meaning                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `agentName`            | The requesting agent's name (from the assistant message that contains the tool call) |
| `mode`                 | The agent's mode (e.g. `build`, `ask`)                                               |
| `profile`              | A policy profile mapped from `agentName` via `actorProfiles`, or `"unknown"`         |
| `identityCompleteness` | `complete` (both name and mode found), `partial` (one), `unknown` (neither)          |
| `sessionID`            | The current session                                                                  |
| `parentSessionID`      | The immediate parent session (if any)                                                |
| `rootSessionID`        | The topmost reachable ancestor (fallback: current session)                           |
| `delegationDepth`      | Number of parent hops resolved                                                       |

## How the requester's identity is recovered

The requester's identity comes **exclusively from the assistant message that
contains the tool call** — not from session metadata:

1. The current session's messages are fetched (this is the same fetch the
   reviewer transcript uses, so there is no extra round-trip).
2. The resolver locates the assistant message whose `info.id` matches
   `request.tool.messageID`.
3. `agentName` = `info.agent`, `mode` = `info.mode`.

The `callID` of the tool is verified against the message parts to set
**confidence**: `confirmed` when the part is found in the message, `high` when
the message is found but the specific tool part is not.

If `tool.messageID` is absent or no message matches, both `agentName` and
`mode` are `undefined` and `identityCompleteness` is `unknown`.

### `identitySource`

The audit field `actor.identitySource` records where the identity claim came
from. In practice it is always one of:

| Value            | When                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `"tool-message"` | The agent name was read from the assistant message containing the tool call (most trusted). |
| `"unavailable"`  | Resolution failed or the message was not found (least trusted).                             |

The `Provenanced<T>.source` union is broader (`"session-api"`,
`"global-config"`, etc.), but those sources carry lineage and profile facts,
not the requester's identity.

## Session lineage

The resolver walks parent sessions via `session.get` SDK calls:

1. Fetch the current session → node 0. `visited = { currentSessionID }`.
2. While the current node has a `parentID`:
   - **Depth/count guard:** stop if `depth >= maxSessionDepth` or the node count
     exceeds `maxParentSessions` (both default to 8). The effective hop limit is
     `min(maxSessionDepth, maxParentSessions)`.
   - **Cycle guard:** if `parentID` was already visited, record
     `cycleDetected: true`, push the back-edge to `missingParents`, and stop.
   - Fetch the parent. On any failure (404, SDK error, missing method), record
     the ID in `missingParents` and stop (the walk does not skip gaps).
   - Otherwise, push the node, increment depth, and continue.
3. `rootSessionID` = the last successfully resolved node (fallback: the current
   session).

The walk is fully sequential — one `session.get` round-trip per hop. On
truncation, the first unreached ancestor ID is appended to `missingParents`.

## Intent recovery

User intent is recovered **separately** from session lineage, into two
categories:

- **`directUserIntent`** — human user text from the current session, the
  immediate parent, and the root session (root only if distinct). Each block
  carries the first non-empty text part of a user message.
- **`delegatedTask`** — subtask or tool-call prompts from the **immediate
  parent only** (`parts` of type `"subtask"` or `type === "tool" && tool ===
"task"`).

### Synthetic-message filtering

Messages matching `Magic Compact:` or token-count notices are dropped from
intent recovery, so compaction artifacts do not pollute the authorization
evidence. A separate filter removes compaction-in-progress and token-count
messages from the transcript and the `USER_INTENT_HISTORY` section.

### Supersession

The most recent explicit user message is presented **last** (as
`latestExplicitAuthorization`), so the reviewer sees the authoritative
instruction in the final position. Conflict resolution (weighing older vs.
newer instructions) is left to the reviewer LLM — there is no mechanical
override.

## Degradation

Actor resolution **never throws**. Every failure degrades to partial or
unknown evidence and the review proceeds:

| Failure                                  | Result                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.get` missing / throws / errors  | Walk stops at the failure; any parents resolved before the failure are preserved, and `rootSessionID` is the last resolved ancestor (or the current session if none resolved) |
| `session.messages` failure (parent/root) | Empty intent blocks; reasons note the gap                                                                                                                                     |
| Cycle detected                           | `cycleDetected: true`, walk stops                                                                                                                                             |
| Bound hit                                | `truncated: true`, next ancestor in `missingParents`                                                                                                                          |
| Any unexpected throw                     | Full fallback: `agentName`/`mode` undefined, `profile: "unknown"`, all provenance `"unavailable"`                                                                             |

The reviewer then sees partial completeness evidence. When the evidence makes
the reviewer report `user_authorization: "unknown"`, the deterministic risk
gate escalates anything medium-or-higher. Degradation is never silent:
`missingParents`, `truncated`, `cycleDetected`, and completeness reasons all
surface in the prompt and audit.

## `actorProfiles`

`config.actorProfiles` is a trusted **name → profile** map (default `{}` — no
mappings shipped). It can only be set in global or inline config (a project
config cannot define profiles).

```jsonc
// ~/.config/opencode/permission-reviewer.jsonc
{
  "actorProfiles": {
    "my-linter-agent": "read-only",
    "my-test-runner": "validation",
  },
}
```

Profiles are generic policy templates, **not** automatic trust levels. A
profile has two effects:

1. It is available as evidence to the reviewer prompt (`ACTOR_CONTEXT.profile`)
   and to the audit.
2. It can be matched by declarative policy rules (`when.actorProfile`).

A profile has **no effect** on the emergency brake or the risk matrix — those
key off the request, not the actor.

## What the reviewer sees

The reviewer prompt receives an `<approval_evidence>` block containing:

- **`ACTOR_CONTEXT`** — `agent`, `mode`, `profile`, `identityCompleteness`,
  `sessionID`, `parentSessionID`, `rootSessionID`, `delegationDepth`.
- **`SESSION_LINEAGE`** — `depth`, `rootSessionID`, `cycleDetected`,
  `truncated`, `missingParents`, and the `chain` of session nodes.
- **`DIRECT_USER_INTENT`** / **`DELEGATED_TASK`** / **`LOCAL_SESSION_CONTEXT`**
  — arrays of `{ actor, text, createdAt? }` blocks.

## What the audit records

The audit record (`schemaVersion: 2`) stores:

- `rootSessionID`
- `evidenceCompleteness` (overall, with per-area breakdown)
- An `actor` snapshot: `{ name?, mode?, profile, identityCompleteness, identitySource, confidence, delegationDepth }`

The full lineage chain is **not** persisted — only `rootSessionID` and the
actor snapshot. `cycleDetected`, `truncated`, and `missingParents` exist in the
prompt only.

## Inspecting actor resolution

- **`opencode-permission-reviewer audit report`** — summarizes the trail and
  flags unknown actors and missing required fields.
- **`opencode-permission-reviewer explain`** — dry-runs a command, but note
  that `explain` runs without a live OpenCode session, so actor context is
  `undefined` in its output (it tests the capability and policy layers only).
