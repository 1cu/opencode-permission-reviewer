import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, resolveConfig, splitModel } from "../src/config.ts"
import { enforceDecision, parseDecision } from "../src/decision.ts"
import { decision } from "./helpers.ts"

describe("decision parsing and invariants", () => {
  test("accepts a valid structured decision", () => {
    expect(parseDecision(decision("allow"))).toEqual(decision("allow"))
  })

  test.each([
    undefined,
    null,
    {},
    { ...decision("allow"), outcome: "execute" },
    { ...decision("allow"), risk_level: "safe" },
    { ...decision("allow"), user_authorization: "admin" },
    { ...decision("allow"), rationale: " " },
    { ...decision("allow"), confidence: Number.NaN },
    { ...decision("allow"), confidence: 1.1 },
  ])("rejects malformed output %#", (value) => {
    expect(parseDecision(value)).toBeUndefined()
  })

  test("critical risk can never be auto-approved", () => {
    const result = enforceDecision(decision("allow", { risk_level: "critical" }), DEFAULT_CONFIG)
    expect(result.kind).toBe("escalate")
  })

  test("critical risk can never be silently escalated by the model", () => {
    const result = enforceDecision(decision("escalate", { risk_level: "critical" }), DEFAULT_CONFIG)
    expect(result.kind).toBe("escalate")
  })

  test("low confidence always goes to a human", () => {
    const result = enforceDecision(decision("allow", { confidence: 0.69 }), DEFAULT_CONFIG)
    expect(result.kind).toBe("escalate")
  })

  test("preserves valid allow, deny, and escalate outcomes", () => {
    expect(enforceDecision(decision("allow"), DEFAULT_CONFIG).kind).toBe("allow")
    expect(enforceDecision(decision("deny"), DEFAULT_CONFIG).kind).toBe("deny")
    expect(enforceDecision(decision("escalate"), DEFAULT_CONFIG).kind).toBe("escalate")
  })
})

describe("configuration", () => {
  test("defaults to Luna at maximum reasoning", () => {
    expect(resolveConfig(undefined).model).toBe("openai/gpt-5.6-luna")
    expect(resolveConfig(undefined).variant).toBe("max")
  })

  test("bounds unsafe numeric options", () => {
    const value = resolveConfig({ timeoutMs: 1, confidenceThreshold: -10, transcriptMessages: 1_000_000 })
    expect(value.timeoutMs).toBe(5_000)
    expect(value.confidenceThreshold).toBe(0.5)
    expect(value.transcriptMessages).toBe(100)
  })

  test("splits provider and model without losing nested model IDs", () => {
    expect(splitModel("openai/gpt-5.6-luna")).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
    expect(() => splitModel("invalid")).toThrow()
  })
})
