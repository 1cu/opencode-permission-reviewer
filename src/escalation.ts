import type {
  EscalationDisposition,
  ReviewDecision,
  ReviewExecutionResult,
  ReviewerConfig,
} from "./types.ts"

/**
 * Categories that can be hardened independently of the global escalation mode
 * via `riskPolicy.onInvalidDecision` / `riskPolicy.onReviewerFailure`.
 * `general` covers every other escalate path (LLM escalate, gates, policy
 * manual, context failures, …).
 */
export type EscalationCategory = "general" | "invalid-decision" | "reviewer-failure"

/**
 * Resolve the effective disposition for an internal escalate.
 *
 * Precedence is monotonic (restrictive wins):
 * 1. `escalationMode: "deny"` hardens every escalate globally.
 * 2. Category knobs can harden only their own case when mode is `manual`.
 * 3. Nothing can relax a more restrictive setting.
 *
 * `manual-superseded` is never converted: the request is already closed.
 */
export function resolveEscalationDisposition(
  result: ReviewExecutionResult,
  config: ReviewerConfig,
  category: EscalationCategory = "general",
): EscalationDisposition {
  if (result.decisionSource === "manual-superseded") return "manual"
  if (result.kind !== "escalate") return "manual"

  if (config.escalationMode === "deny") return "deny"

  if (category === "invalid-decision" && config.riskPolicy.onInvalidDecision === "deny") {
    return "deny"
  }
  if (category === "reviewer-failure" && config.riskPolicy.onReviewerFailure === "deny") {
    return "deny"
  }
  return "manual"
}

/**
 * Single enforcement boundary: convert an internal escalate into the effective
 * disposition used for UI, reply, and audit. Allow/deny and manual-superseded
 * pass through unchanged.
 *
 * When converting escalate → deny, the original reason is preserved so the
 * primary agent still receives actionable feedback.
 */
export function applyEscalationDisposition(
  result: ReviewExecutionResult,
  config: ReviewerConfig,
  category: EscalationCategory = "general",
): ReviewExecutionResult {
  if (result.decisionSource === "manual-superseded") return result
  if (result.kind !== "escalate") return result

  const disposition = resolveEscalationDisposition(result, config, category)
  const reviewerOutcome =
    result.reviewerOutcome ??
    (result.decision !== undefined ? result.decision.outcome : ("escalate" as const))

  if (disposition === "manual") {
    return {
      ...result,
      reviewerOutcome,
      escalationDisposition: "manual",
    }
  }

  return {
    kind: "deny",
    decision: result.decision ?? syntheticDenyDecision(result.reason),
    reason: result.reason,
    ...(result.reviewSessionID === undefined ? {} : { reviewSessionID: result.reviewSessionID }),
    ...(result.decisionSource === undefined ? {} : { decisionSource: result.decisionSource }),
    reviewerOutcome,
    escalationDisposition: "deny",
  }
}

function syntheticDenyDecision(reason: string): ReviewDecision {
  const rationale =
    reason.trim().length >= 3
      ? reason.trim().slice(0, 2_000)
      : "Escalation converted to deny by fail-closed enforcement."
  return {
    version: 2,
    outcome: "deny",
    risk_level: "high",
    user_authorization: "unknown",
    scope_alignment: "unknown",
    evidence_completeness: "unknown",
    rationale,
    confidence: 1,
  }
}
