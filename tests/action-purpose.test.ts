import { describe, expect, test } from "bun:test"
import { resolveActionPurpose } from "../src/context/action-purpose.ts"
import { buildEvidence } from "../src/context.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { IntentContext, PermissionRequest, ReviewEnvelope } from "../src/types.ts"
import { request } from "./helpers.ts"

function intent(partial: Partial<IntentContext> = {}): IntentContext {
  return {
    directUserIntent: [],
    delegatedTask: [],
    localSessionIntent: [],
    conflictingInstructions: [],
    completeness: "partial",
    ...partial,
  }
}

function block(text: string, sessionID = "ses_parent") {
  return {
    sessionID,
    messageID: "msg_1",
    actor: "user" as const,
    text,
    synthetic: false,
    provenance: {
      value: "intent" as const,
      source: "parent-session" as const,
      confidence: "high" as const,
    },
  }
}

describe("resolveActionPurpose", () => {
  test("prefers agent-context metadata over intent", () => {
    const req: PermissionRequest = request({
      metadata: { command: "printf safe", purpose: "Run the narrow safe check" },
    })
    const result = resolveActionPurpose(
      req,
      intent({ delegatedTask: [block("delegated fallback that must not win")] }),
    )
    expect(result).toEqual({
      text: "Run the narrow safe check",
      source: "agent-context",
      confidence: "medium",
    })
  })

  test("prefers local session intent over delegated task", () => {
    const result = resolveActionPurpose(
      request(),
      intent({
        localSessionIntent: [block("Local subagent task text")],
        delegatedTask: [block("Sibling delegated brief that must not win")],
      }),
    )
    expect(result.source).toBe("intent-derived")
    expect(result.text).toBe("Local subagent task text")
  })

  test("uses a single unambiguous delegated task when local intent is absent", () => {
    const delegated = resolveActionPurpose(
      request(),
      intent({ delegatedTask: [block("Implement the permission disposition boundary")] }),
    )
    expect(delegated.source).toBe("intent-derived")
    expect(delegated.text).toContain("disposition boundary")
  })

  test("does not attribute sibling delegated tasks when multiple are present", () => {
    const result = resolveActionPurpose(
      request(),
      intent({
        delegatedTask: [
          block("First sibling brief"),
          block("Second sibling brief that is merely the latest"),
        ],
      }),
    )
    expect(result).toEqual({ source: "unavailable", confidence: "unknown" })
  })

  test("returns unavailable when no evidence exists", () => {
    expect(resolveActionPurpose(request(), intent())).toEqual({
      source: "unavailable",
      confidence: "unknown",
    })
    expect(resolveActionPurpose(request(), undefined)).toEqual({
      source: "unavailable",
      confidence: "unknown",
    })
  })

  test("never invents purpose from command strings alone", () => {
    const result = resolveActionPurpose(
      request({ metadata: { command: "rm -rf /tmp/scratch" } }),
      intent(),
    )
    expect(result.source).toBe("unavailable")
    expect(result.text).toBeUndefined()
  })
})

describe("ACTION_PURPOSE in evidence", () => {
  test("buildEvidence always emits ACTION_PURPOSE", () => {
    const envelope: ReviewEnvelope = {
      request: request(),
      directory: "/workspace/project",
      worktree: "/workspace/project",
      transcript: "",
      intentHistory: "",
      enrichment: "",
      sshAudit: [],
      actionPurpose: { source: "unavailable", confidence: "unknown" },
    }
    const evidence = buildEvidence(envelope, DEFAULT_CONFIG)
    expect(evidence).toContain("ACTION_PURPOSE")
    expect(evidence).toContain('"source": "unavailable"')
  })

  test("buildEvidence includes purpose text when available", () => {
    const envelope: ReviewEnvelope = {
      request: request(),
      directory: "/workspace/project",
      worktree: "/workspace/project",
      transcript: "",
      intentHistory: "",
      enrichment: "",
      sshAudit: [],
      actionPurpose: {
        text: "Validate fail-closed disposition",
        source: "agent-context",
        confidence: "medium",
      },
    }
    const evidence = buildEvidence(envelope, DEFAULT_CONFIG)
    expect(evidence).toContain("Validate fail-closed disposition")
    expect(evidence).toContain('"source": "agent-context"')
  })
})
