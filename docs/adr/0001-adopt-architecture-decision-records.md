# ADR 0001: Adopt architecture decision records

## Status

Accepted

## Context

The plugin has grown several non-obvious architectural choices (raw TSX TUI
shipping, raw HTTP reply transport, config trust boundary) whose rationale
lives in commit messages, code comments, or private notes. New contributors
have no single place to find _why_ a decision was made, only _what_ it is.

## Decision

Record significant architectural decisions as ADRs in `docs/adr/`. Each entry
is a short markdown file covering context, decision, and consequences. Entries
are immutable once accepted; a later decision supersedes an earlier one with a
new ADR and a status update, rather than rewriting history.

## Consequences

- **Positive:** the reasoning behind non-obvious choices is discoverable and
  durable.
- **Positive:** future changes have a reference point to argue against.
- **Negative:** a small maintenance cost (writing and keeping the index
  current).
- **Neutral:** ADRs document past reasoning; they are not a forward-looking
  roadmap.
