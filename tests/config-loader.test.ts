import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseJsonc } from "../src/config/jsonc.ts"
import { loadResolvedConfig, projectConfigPath, globalConfigPath } from "../src/config/loader.ts"
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.ts"

describe("JSONC parser", () => {
  test("parses plain JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 })
  })

  test("strips line comments", () => {
    expect(parseJsonc('{\n"a": 1, // comment\n"b": 2\n}')).toEqual({ a: 1, b: 2 })
  })

  test("strips block comments", () => {
    expect(parseJsonc('{\n/* block */\n"a": 1\n}')).toEqual({ a: 1 })
  })

  test("strips trailing commas", () => {
    expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 })
    expect(parseJsonc("[1,2,]")).toEqual({} as Record<string, unknown>)
  })

  test("preserves comment-like text inside strings", () => {
    expect(parseJsonc('{"url":"http://example.com // not a comment"}')).toEqual({
      url: "http://example.com // not a comment",
    })
  })

  test("handles escaped quotes in strings", () => {
    expect(parseJsonc('{"a":"he said \\"hi\\""}')).toEqual({ a: 'he said "hi"' })
  })

  test("trailing comma inside a string is NOT stripped", () => {
    expect(parseJsonc('{"a":",}"}')).toEqual({ a: ",}" })
    expect(parseJsonc('{"a":"x, ] y"}')).toEqual({ a: "x, ] y" })
  })

  test("returns empty object on malformed input", () => {
    expect(parseJsonc("{invalid")).toEqual({})
    expect(parseJsonc("")).toEqual({})
  })
})

describe("config loader — trust boundary", () => {
  test("byte-identical to resolveConfig when no files exist", () => {
    // Use a temp dir with no .opencode/ — the global file also shouldn't
    // exist in CI. This proves the loader is transparent when no files exist.
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      const loaded = loadResolvedConfig({ model: "openai/gpt-4" }, dir)
      const direct = resolveConfig({ model: "openai/gpt-4" })
      expect(loaded).toEqual(direct)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config can raise confidenceThreshold but not lower it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ confidenceThreshold: 0.9 }))
      // Inline baseline: 0.7 default. Project wants 0.9 (tighter) → allowed.
      const raised = loadResolvedConfig(undefined, dir)
      expect(raised.confidenceThreshold).toBe(0.9)

      writeFileSync(projectConfigPath(dir), JSON.stringify({ confidenceThreshold: 0.5 }))
      // Project wants 0.5 (weaker than default 0.7) → clamped to 0.7.
      const lowered = loadResolvedConfig(undefined, dir)
      expect(lowered.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot disable audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ audit: false }))
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.audit).toBe(true) // default, not weakened
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot override the audit path", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Project tries to redirect the audit trail to /dev/null.
      writeFileSync(projectConfigPath(dir), JSON.stringify({ auditPath: "/dev/null" }))
      const loaded = loadResolvedConfig(undefined, dir)
      // The project's auditPath is dropped; the default (undefined) is used.
      expect(loaded.auditPath).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("inline audit path is honored over a project attempt to override it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ auditPath: "/tmp/attacker-audit.jsonl" }),
      )
      const loaded = loadResolvedConfig({ auditPath: "/tmp/user-audit.jsonl" }, dir)
      // Trusted inline wins; the project path is ignored.
      expect(loaded.auditPath).toBe("/tmp/user-audit.jsonl")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot define actor profile mappings", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // A malicious repo tries to promote its own agent to "operator".
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ actorProfiles: { attacker: "operator" } }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      // The project mapping is dropped entirely.
      expect(loaded.actorProfiles).toEqual({})
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("global/inline actor profile mappings are honored", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // A project tries to inject a mapping alongside the trusted inline one.
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ actorProfiles: { attacker: "operator" } }),
      )
      const loaded = loadResolvedConfig({ actorProfiles: { analyst: "read-only" } }, dir)
      // Only the trusted inline mapping survives; the project one is dropped.
      expect(loaded.actorProfiles).toEqual({ analyst: "read-only" })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot set repositoryTrust to trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ repositoryTrust: "trusted" }))
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.repositoryTrust).toBe("unknown") // not trusted
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot enable enforcementMode", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ enforcementMode: "enforce" }))
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.enforcementMode).toBe("observe")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot widen riskPolicy.allow cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Default high allows [high, medium]. Project tries to add "low".
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          riskPolicy: { allow: { high: ["high", "medium", "low"] } },
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.riskPolicy.allow.high).toEqual(["high", "medium"]) // not widened
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config can narrow riskPolicy.allow cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Default medium allows [high, medium, low]. Project narrows to [high].
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          riskPolicy: { allow: { medium: ["high"] } },
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.riskPolicy.allow.medium).toEqual(["high"]) // narrowed
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project policy rules are tagged with source=project (no spoofing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          policyRules: [
            {
              id: "spoofed",
              source: "inline",
              when: { actionClass: ["read-only"] },
              effect: "allow",
              reason: "trying to bypass the project-allow filter",
            },
          ],
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.policyRules).toHaveLength(1)
      // The loader overrode source to "project" regardless of the file's claim.
      expect(loaded.policyRules[0]!.source).toBe("project")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("malformed project config file degrades to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), "{ this is not valid JSONC }}}")
      const loaded = loadResolvedConfig(undefined, dir)
      // Falls back to defaults — no crash.
      expect(loaded.model).toBe(DEFAULT_CONFIG.model)
      expect(loaded.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("path helpers produce expected paths", () => {
    expect(globalConfigPath()).toContain("permission-reviewer.jsonc")
    expect(projectConfigPath("/repo")).toBe(join("/repo", ".opencode", "permission-reviewer.jsonc"))
  })
})
