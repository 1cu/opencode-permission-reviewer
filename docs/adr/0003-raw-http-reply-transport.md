# ADR 0003: Reply through the authenticated raw HTTP transport

## Status

Accepted

## Context

OpenCode's `@opencode-ai/plugin` SDK (1.18.x) has no typed V1 method for
`POST /permission/{requestID}/reply`. The closest typed call targets a
different endpoint. The reviewer needs to send a permission reply (allow once,
deny with feedback, or escalate) and carry a rationale message so the primary
agent sees why.

## Decision

Reply through an **isolated transport** chosen once at startup via a priority
chain:

1. Public SDK reply **with** a feedback `message` (if the host exposes it).
2. Public reply **plus** a separate feedback channel.
3. Authenticated raw HTTP (`/permission/{requestID}/reply` via
   `input.client._client.post`).
4. **Refuse startup** if none of the above is available (fail safe — never
   reply through an unverified path).

Host capabilities are probed once at startup; the chosen path is used for the
entire session. On OpenCode 1.18.x the chain resolves to the raw transport (the
message-bearing path is only reachable there). v2-generation hosts are detected
and refused until their reply contract is verified.

## Consequences

- **Positive:** the reviewer can reply and annotate, which is the plugin's
  core function.
- **Positive:** when a host exposes the public message-bearing reply, the
  plugin uses it automatically — no code change needed.
- **Positive:** failing safe at startup (refusing partial startup) is safer
  than replying through an unverified path.
- **Negative:** the raw HTTP field (`_client.post`) is not part of OpenCode's
  public plugin API and can change without notice. If startup fails with
  _"authenticated SDK transport is unavailable"_, the user must upgrade
  OpenCode or report the version, not downgrade.
