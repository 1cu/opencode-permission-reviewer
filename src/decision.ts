import type { ReviewDecision, ReviewExecutionResult, ReviewerConfig } from "./types.ts"

const OUTCOMES = new Set(["allow", "deny", "escalate"])
const RISKS = new Set(["low", "medium", "high", "critical"])
const AUTHORIZATIONS = new Set(["high", "medium", "low", "unknown"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseDecision(value: unknown): ReviewDecision | undefined {
  if (!isRecord(value)) return
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return
  if (typeof value.risk_level !== "string" || !RISKS.has(value.risk_level)) return
  if (typeof value.user_authorization !== "string" || !AUTHORIZATIONS.has(value.user_authorization)) return
  if (typeof value.rationale !== "string") return
  const rationale = value.rationale.trim()
  if (rationale.length < 3 || rationale.length > 2_000) return
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return
  if (value.confidence < 0 || value.confidence > 1) return

  return {
    outcome: value.outcome as ReviewDecision["outcome"],
    risk_level: value.risk_level as ReviewDecision["risk_level"],
    user_authorization: value.user_authorization as ReviewDecision["user_authorization"],
    rationale,
    confidence: value.confidence,
  }
}

export function enforceDecision(decision: ReviewDecision, config: ReviewerConfig): ReviewExecutionResult {
  if (decision.risk_level === "critical" && decision.outcome !== "deny") {
    return {
      kind: "escalate",
      decision,
      reason: "Reviewer returned a non-denial for critical risk; manual review required.",
    }
  }

  if (decision.confidence < config.confidenceThreshold) {
    return {
      kind: "escalate",
      decision,
      reason: `Reviewer confidence ${decision.confidence.toFixed(2)} is below ${config.confidenceThreshold.toFixed(2)}.`,
    }
  }

  if (decision.outcome === "allow") {
    return { kind: "allow", decision, reason: decision.rationale }
  }
  if (decision.outcome === "deny") {
    return { kind: "deny", decision, reason: decision.rationale }
  }
  return { kind: "escalate", decision, reason: decision.rationale }
}

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "risk_level", "user_authorization", "rationale", "confidence"],
  properties: {
    outcome: {
      type: "string",
      enum: ["allow", "deny", "escalate"],
      description: "allow executes once, deny rejects, escalate leaves the request for a human",
    },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    user_authorization: {
      type: "string",
      enum: ["high", "medium", "low", "unknown"],
    },
    rationale: {
      type: "string",
      minLength: 3,
      maxLength: 2000,
      description: "One concise sentence explaining the main reason for the decision",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
} as const
