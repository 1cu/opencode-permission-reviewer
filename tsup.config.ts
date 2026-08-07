import { defineConfig } from "tsup"

// dist/ is the ship set for the server and CLI. The TUI entry is copied as raw
// TSX by scripts/copy-tui.ts so OpenCode's host can compile it with its own
// Solid/OpenTUI pipeline (a prebundled TUI does not render on the host).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    explain: "src/cli/explain.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  // A split chunk breaks direct path loading under Bun, so keep it off.
  splitting: false,
  clean: true,
  sourcemap: false,
  dts: true,
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opencode-ai/sdk",
    /^@opentui\//,
    "solid-js",
    "solid-js/web",
  ],
})
