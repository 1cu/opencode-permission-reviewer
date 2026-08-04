import type { ReviewerConfig } from "./types.ts"

export const DEFAULT_CONFIG: ReviewerConfig = {
  model: "openai/gpt-5.6-luna",
  variant: "max",
  timeoutMs: 120_000,
  maxContextChars: 32_000,
  maxPartChars: 8_000,
  maxEnrichmentChars: 24_000,
  maxIntentChars: 8_000,
  transcriptMessages: 12,
  intentMessages: 8,
  historyMessages: 200,
  confidenceThreshold: 0.7,
  retainReviewSessions: false,
  audit: true,
  debug: false,
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function resolveConfig(options: Record<string, unknown> | undefined): ReviewerConfig {
  const source = options ?? {}
  const model = typeof source.model === "string" && source.model.includes("/") ? source.model : DEFAULT_CONFIG.model
  const variant = typeof source.variant === "string" && source.variant.length > 0 ? source.variant : DEFAULT_CONFIG.variant
  const policy = typeof source.policy === "string" && source.policy.trim().length > 0 ? source.policy.trim() : undefined
  const auditPath =
    typeof source.auditPath === "string" && source.auditPath.trim().length > 0
      ? source.auditPath.trim()
      : undefined

  return {
    model,
    variant,
    timeoutMs: boundedInteger(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, 5_000, 600_000),
    maxContextChars: boundedInteger(source.maxContextChars, DEFAULT_CONFIG.maxContextChars, 4_000, 200_000),
    maxPartChars: boundedInteger(source.maxPartChars, DEFAULT_CONFIG.maxPartChars, 500, 50_000),
    maxEnrichmentChars: boundedInteger(
      source.maxEnrichmentChars,
      DEFAULT_CONFIG.maxEnrichmentChars,
      1_000,
      100_000,
    ),
    maxIntentChars: boundedInteger(source.maxIntentChars, DEFAULT_CONFIG.maxIntentChars, 1_000, 50_000),
    transcriptMessages: boundedInteger(source.transcriptMessages, DEFAULT_CONFIG.transcriptMessages, 1, 100),
    intentMessages: boundedInteger(source.intentMessages, DEFAULT_CONFIG.intentMessages, 1, 50),
    historyMessages: boundedInteger(source.historyMessages, DEFAULT_CONFIG.historyMessages, 20, 500),
    confidenceThreshold: boundedNumber(
      source.confidenceThreshold,
      DEFAULT_CONFIG.confidenceThreshold,
      0.5,
      1,
    ),
    retainReviewSessions:
      typeof source.retainReviewSessions === "boolean"
        ? source.retainReviewSessions
        : DEFAULT_CONFIG.retainReviewSessions,
    audit: typeof source.audit === "boolean" ? source.audit : DEFAULT_CONFIG.audit,
    ...(auditPath === undefined ? {} : { auditPath }),
    ...(policy === undefined ? {} : { policy }),
    debug: typeof source.debug === "boolean" ? source.debug : DEFAULT_CONFIG.debug,
  }
}

export function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Invalid reviewer model "${model}"; expected provider/model`)
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}
