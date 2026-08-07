# Architecture Decision Records

An ADR captures **why** a significant architectural choice was made — the
context, the decision, and its consequences. They live in this directory,
numbered in the order they were adopted.

ADR is a lightweight record, not a design document. Each entry should be short
(one page) and immutable once merged; supersede rather than edit.

## Format

```
# ADR NNNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR MMMM

## Context
Why this decision was needed — the forces, constraints, and alternatives.

## Decision
What we decided to do.

## Consequences
What follows: positive, negative, and neutral effects.
```

## Index

- [0001 — Adopt architecture decision records](./0001-adopt-architecture-decision-records.md)
- [0002 — Ship the TUI overlay as raw TSX](./0002-ship-tui-overlay-as-raw-tsx.md)
- [0003 — Reply through the authenticated raw HTTP transport](./0003-raw-http-reply-transport.md)
- [0004 — Project configuration trust boundary](./0004-project-config-trust-boundary.md)
