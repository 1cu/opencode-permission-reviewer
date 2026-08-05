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

  // Deterministic risk×authorization gate. This only ever RESTRICTS an `allow`:
  // the model's `deny`/`escalate` outcomes are always preserved. Low confidence
  // is checked first because, when the labels are unreliable, the confidence
  // reason is the right diagnosis to surface to a human.
  //
  // Matrix for outcome=allow (confidence ≥ threshold):
  //                 high      medium    low         unknown
  //   low           allow     allow     allow       allow (deliberate)
  //   medium        allow     allow     allow*      ESCALATE
  //   high          allow     allow     ESCALATE    ESCALATE
  //   critical      ESCALATE (any authorization, handled above)
  //
  // The two permissive cells (medium+low, low+unknown) are deliberate: low risk
  // means routine, narrow and reversible, where authorization evidence is not
  // essential. Medium+unknown escalates because non-trivial blast radius needs
  // at least some authorization signal. Everything high or critical with weak
  // authorization must not be auto-approved.
  if (decision.outcome === "allow") {
    const { risk_level: risk, user_authorization: auth } = decision
    if ((risk === "high" && (auth === "low" || auth === "unknown")) || (risk === "medium" && auth === "unknown")) {
      return {
        kind: "escalate",
        decision,
        reason: `Reviewer allow for ${risk} risk with ${auth} user authorization; manual review required.`,
      }
    }
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
