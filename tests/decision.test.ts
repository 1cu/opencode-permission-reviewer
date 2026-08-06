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

  test("the model can never auto-approve high risk with low or unknown authorization", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "low" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
    // The exact contradiction the comparative analysis flagged.
    const flagged = enforceDecision(
      decision("allow", { risk_level: "high", user_authorization: "unknown", confidence: 0.95 }),
      DEFAULT_CONFIG,
    )
    expect(flagged.kind).toBe("escalate")
    expect(flagged.reason).toContain("high risk")
  })

  test("high risk with at least medium authorization is approved when the model allows", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "medium" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "high" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
  })

  test("medium risk with unknown authorization escalates; medium+low is deliberately approved", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "medium", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "medium", user_authorization: "low" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
  })

  test("low risk never escalates on authorization alone", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "low", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "low", user_authorization: "low" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
  })

  test("the gate never relaxes a deny or escalate, regardless of risk and authorization", () => {
    expect(
      enforceDecision(
        decision("deny", { risk_level: "high", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("deny")
    expect(
      enforceDecision(
        decision("escalate", { risk_level: "high", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
  })

  test("low confidence takes precedence over the risk×authorization reason", () => {
    const result = enforceDecision(
      decision("allow", { risk_level: "high", user_authorization: "unknown", confidence: 0.5 }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("confidence")
  })

  test("full allow matrix (every risk×authorization cell)", () => {
    const expectAllow = (risk: string, auth: string) => {
      const result = enforceDecision(
        decision("allow", { risk_level: risk as never, user_authorization: auth as never }),
        DEFAULT_CONFIG,
      )
      expect({ risk, auth, kind: result.kind }).toEqual({ risk, auth, kind: "allow" })
    }
    const expectEscalate = (risk: string, auth: string) => {
      const result = enforceDecision(
        decision("allow", { risk_level: risk as never, user_authorization: auth as never }),
        DEFAULT_CONFIG,
      )
      expect({ risk, auth, kind: result.kind }).toEqual({ risk, auth, kind: "escalate" })
    }
    // low
    expectAllow("low", "high")
    expectAllow("low", "medium")
    expectAllow("low", "low")
    expectAllow("low", "unknown")
    // medium
    expectAllow("medium", "high")
    expectAllow("medium", "medium")
    expectAllow("medium", "low")
    expectEscalate("medium", "unknown")
    // high
    expectAllow("high", "high")
    expectAllow("high", "medium")
    expectEscalate("high", "low")
    expectEscalate("high", "unknown")
    // critical
    expectEscalate("critical", "high")
    expectEscalate("critical", "medium")
    expectEscalate("critical", "low")
    expectEscalate("critical", "unknown")
  })
})

describe("configuration", () => {
  test("defaults to Luna at maximum reasoning", () => {
    expect(resolveConfig(undefined).model).toBe("openai/gpt-5.6-luna")
    expect(resolveConfig(undefined).variant).toBe("max")
  })

  test("bounds unsafe numeric options", () => {
    const value = resolveConfig({
      timeoutMs: 1,
      confidenceThreshold: -10,
      transcriptMessages: 1_000_000,
    })
    expect(value.timeoutMs).toBe(5_000)
    expect(value.confidenceThreshold).toBe(0.5)
    expect(value.transcriptMessages).toBe(100)
  })

  test("splits provider and model without losing nested model IDs", () => {
    expect(splitModel("openai/gpt-5.6-luna")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    })
    expect(() => splitModel("invalid")).toThrow()
  })
})
