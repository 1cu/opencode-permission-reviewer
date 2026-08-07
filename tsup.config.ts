import { defineConfig } from "tsup"

// dist/ is the ship set: ESM bundles that load directly by path. OpenCode-
// provided packages (plugin SDK, TUI runtime, Solid) stay external because the
// host resolves them from its own node_modules; only the built output ships.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    tui: "src/tui.tsx",
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
  esbuildOptions(options) {
    // The TUI uses Solid's automatic JSX runtime. The per-file jsxImportSource
    // pragma is absent today (the project relies on tsconfig), so set it here
    // explicitly for the bundle. The server entry has no JSX and is unaffected.
    options.jsx = "automatic"
    options.jsxImportSource = "@opentui/solid"
  },
})
