# ADR 0002: Ship the TUI overlay as raw TSX

## Status

Accepted

## Context

OpenCode's host compiles plugin `.tsx` entries with its own embedded
Solid/OpenTUI pipeline (babel-preset-solid + the `@opentui/solid` JSX runtime).
A tsup-bundled `dist/tui.js` (with the JSX pre-compiled to `solid-js/web`
render calls) loads without error but the component never mounts — the host
renderer does not consume those pre-compiled call shapes. The result: the
overlay is invisible even though the module loads cleanly.

## Decision

Ship the TUI entry as **raw TSX** (`dist/tui/tui.tsx`), copied by
`scripts/copy-tui.ts`, so the host compiles it with its own pipeline. The
`./tui` export points at `dist/tui/tui.tsx` (not a JS bundle). The copied graph
is kept slim: it must not pull the server engine or `node:` builtins into the
TUI process — the TUI imports the event normalizer directly, not the runtime.

## Consequences

- **Positive:** the overlay renders correctly under the host pipeline.
- **Positive:** the TUI and server halves are cleanly decoupled.
- **Negative:** the file list in `scripts/copy-tui.ts` must be kept in sync
  with the imports of `src/tui.tsx` and its copied modules. A missing file
  breaks the overlay on the host (unit tests do not catch this — only
  `tests/package-smoke.test.ts` and a live load test do).
- **Negative:** a prebundled TUI entry must never be reintroduced — it will
  appear to work (loads, no errors) but never paint.
