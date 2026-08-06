import type {
  EvidenceSufficiency,
  ReviewDecision,
  ReviewExecutionResult,
  ReviewerConfig,
  ScopeAlignment,
} from "./types.ts"

const OUTCOMES = new Set(["allow", "deny", "escalate"])
const RISKS = new Set(["low", "medium", "high", "critical"])
const AUTHORIZATIONS = new Set(["high", "medium", "low", "unknown"])
const SCOPE_ALIGNMENTS = new Set(["aligned", "partial", "misaligned", "unknown"])
const EVIDENCE_SUFFICIENCY = new Set(["sufficient", "partial", "insufficient", "unknown"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseDecision(value: unknown): ReviewDecision | undefined {
  if (!isRecord(value)) return
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return
  if (typeof value.risk_level !== "string" || !RISKS.has(value.risk_level)) return
  if (typeof value.user_authorization !== "string" || !AUTHORIZATIONS.has(value.user_authorization))
    return
  if (typeof value.rationale !== "string") return
  const rationale = value.rationale.trim()
  if (rationale.length < 3 || rationale.length > 2_000) return
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return
  if (value.confidence < 0 || value.confidence > 1) return

  // Schema v2 fields: validated when present, defaulted to "unknown" when absent
  // so a v1 decision (without these fields) still parses cleanly. An invalid
  // value (present but not in the enum) rejects the whole decision — the model
  // isn't following the schema and we escalate rather than silently default.
  let scope_alignment: ScopeAlignment = "unknown"
  if (value.scope_alignment !== undefined) {
    if (typeof value.scope_alignment !== "string" || !SCOPE_ALIGNMENTS.has(value.scope_alignment))
      return
    scope_alignment = value.scope_alignment as ScopeAlignment
  }
  let evidence_completeness: EvidenceSufficiency = "unknown"
  if (value.evidence_completeness !== undefined) {
    if (
      typeof value.evidence_completeness !== "string" ||
      !EVIDENCE_SUFFICIENCY.has(value.evidence_completeness)
    )
      return
    evidence_completeness = value.evidence_completeness as EvidenceSufficiency
  }

  return {
    outcome: value.outcome as ReviewDecision["outcome"],
    risk_level: value.risk_level as ReviewDecision["risk_level"],
    user_authorization: value.user_authorization as ReviewDecision["user_authorization"],
    rationale,
    confidence: value.confidence,
    scope_alignment,
    evidence_completeness,
  }
}

export function enforceDecision(
  decision: ReviewDecision,
  config: ReviewerConfig,
): ReviewExecutionResult {
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

  // Deterministic risk×authorization gate, now driven by the configurable
  // riskPolicy matrix. This only ever RESTRICTS an `allow`: the model's
  //deny`/`escalate` outcomes are always preserved. The default matrix
  // es the previous hard-coded behavior exactly.
  if (decision.outcome === "allow") {
    const { risk_level: risk, user_authorization: auth } = decision
    const permitted = config.riskPolicy.allow[risk]
    if (permitted === undefined || !permitted.includes(auth)) {
      return {
        kind: "escalate",
        decision,
        reason: `Reviewer allow for ${risk} risk with ${auth} user authorization; manual review required.`,
      }
    }

    // Schema v2 gate: a request the reviewer judged misaligned with the
    // recovered user/delegated intent is never auto-allowed.
    if (decision.scope_alignment === "misaligned") {
      return {
        kind: "escalate",
        decision,
        reason:
          "Reviewer judged the request misaligned with the stated intent; manual review required.",
      }
    }

    // Schema v2 gate: for medium-or-higher risk, insufficient evidence
    // prevents auto-allow (the reviewer cannot confidently judge).
    if (
      (risk === "medium" || risk === "high" || risk === "critical") &&
      decision.evidence_completeness === "insufficient"
    ) {
      return {
        kind: "escalate",
        decision,
        reason: `Reviewer judged evidence insufficient for ${risk} risk; manual review required.`,
      }
    }

    return { kind: "allow", decision, reason: decision.rationale }
  }
  if (decision.outcome === "deny") {
    return { kind: "deny", decision, reason: decision.rationale }
  }
  return { kind: "escalate", decision, reason: decision.rationale }
}

export const DECISION_SCHEMA_VERSION = 2

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
    scope_alignment: {
      type: "string",
      enum: ["aligned", "partial", "misaligned", "unknown"],
      description:
        "How well the request aligns with the recovered user or delegated intent: aligned (within scope), partial (tangential), misaligned (outside scope), unknown (insufficient context).",
    },
    evidence_completeness: {
      type: "string",
      enum: ["sufficient", "partial", "insufficient", "unknown"],
      description:
        "Whether the evidence was sufficient to decide: sufficient, partial (some gaps), insufficient (major gaps), unknown.",
    },
  },
} as const
