#!/usr/bin/env bun
/*
 * explain — dry-run a bash command through the capability analyzer and policy
 * engine without a running opencode. Reads a permission request from a JSON
 * fixture (or stdin), resolves the effective config, and prints the capability
 * assessment + policy trace as JSON to stdout.
 *
 * Usage:
 *   opencode-permission-reviewer explain --event fixture.json
 *   opencode-permission-reviewer explain --event fixture.json --project /repo
 *   cat fixture.json | opencode-permission-reviewer explain
 */
import { parseArgs } from "node:util"
import { readFileSync } from "node:fs"
import { resolveConfig } from "../config.ts"
import { parseCommand } from "../capability/command-parser.ts"
import { analyzeCapability } from "../capability/bash-analyzer.ts"
import { evaluatePolicy } from "../policy/policy-engine.ts"
import type { PermissionRequest, PermissionToolSource } from "../types.ts"

const { values } = parseArgs({
  options: {
    event: { type: "string" },
    project: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
})

if (values.help) {
  console.error(`Usage: explain --event <fixture.json> [--project <dir>]
Reads a permission request JSON, runs the capability analyzer and policy engine
(observe mode), and prints the result as JSON.`)
  process.exit(0)
}

let raw: string
if (values.event) {
  raw = readFileSync(values.event, "utf8")
} else {
  raw = await readStdin()
}

let parsed: unknown
try {
  parsed = JSON.parse(raw)
} catch {
  console.error("explain: input is not valid JSON")
  process.exit(2)
}

const request = normalizeRequest(parsed)
if (request === undefined) {
  console.error('explain: input must have "permission" and "metadata.command" or "patterns"')
  process.exit(2)
}

const config = resolveConfig(undefined)
const directory = values.project ?? process.cwd()
const worktree = directory

const command =
  typeof request.metadata?.command === "string"
    ? request.metadata.command
    : (request.patterns ?? []).filter((p) => typeof p === "string").join("\n")

const result: Record<string, unknown> = {
  permission: request.permission,
  command,
}

if (request.permission === "bash" && command.trim()) {
  const parsedCmd = parseCommand(command)
  const capability = analyzeCapability(parsedCmd, directory, worktree)
  const policyTrace = evaluatePolicy(capability, undefined, config, config.policyRules)
  result.capability = capability
  result.policyTrace = policyTrace
} else {
  result.capability = null
  result.policyTrace = evaluatePolicy(undefined, undefined, config, config.policyRules)
}

console.log(JSON.stringify(result, null, 2))

// --- helpers ----------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => resolve(data))
  })
}

function normalizeRequest(value: unknown): PermissionRequest | undefined {
  if (typeof value !== "object" || value === null) return
  const v = value as Record<string, unknown>
  if (typeof v.permission !== "string") return
  const req: PermissionRequest = {
    id: typeof v.id === "string" ? v.id : "explain-dry-run",
    sessionID: typeof v.sessionID === "string" ? v.sessionID : "explain-session",
    permission: v.permission,
    patterns: Array.isArray(v.patterns) ? v.patterns : [],
    always: Array.isArray(v.always) ? v.always : [],
    metadata:
      typeof v.metadata === "object" && v.metadata !== null
        ? (v.metadata as Record<string, unknown>)
        : {},
  }
  if (
    typeof v.tool === "object" &&
    v.tool !== null &&
    typeof (v.tool as Record<string, unknown>).messageID === "string"
  ) {
    req.tool = v.tool as PermissionToolSource
  }
  return req
}
