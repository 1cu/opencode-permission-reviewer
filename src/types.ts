export type RiskLevel = "low" | "medium" | "high" | "critical"
export type UserAuthorization = "high" | "medium" | "low" | "unknown"
export type ReviewOutcome = "allow" | "deny" | "escalate"

export interface ReviewDecision {
  outcome: ReviewOutcome
  risk_level: RiskLevel
  user_authorization: UserAuthorization
  rationale: string
  confidence: number
}

export interface PermissionToolSource {
  messageID: string
  callID: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: PermissionToolSource
}

export interface MessageWithParts {
  info: Record<string, unknown> & {
    id?: string
    role?: string
    structured?: unknown
  }
  parts: Array<Record<string, unknown>>
}

export interface ReviewerConfig {
  model: string
  variant: string
  timeoutMs: number
  maxContextChars: number
  maxPartChars: number
  maxEnrichmentChars: number
  maxIntentChars: number
  transcriptMessages: number
  intentMessages: number
  historyMessages: number
  confidenceThreshold: number
  retainReviewSessions: boolean
  audit: boolean
  auditPath?: string
  policy?: string
  debug: boolean
}

export interface ReviewEnvelope {
  request: PermissionRequest
  directory: string
  worktree: string
  transcript: string
  intentHistory: string
  enrichment: string
  sshAudit: NonNullable<ReviewAuditRecord["ssh"]>
  preflightDenial?: string
}

export interface ReviewAuditRecord {
  /**
   * Audit schema version. Present on every record written since 0.6.0; readers
   * default a missing field to `1` (additive — old records are still valid).
   * Bump only on a breaking change to the record shape.
   */
  schemaVersion?: number
  timestamp: string
  durationMs: number
  requestID: string
  sessionID: string
  permission: string
  outcome: ReviewExecutionResult["kind"]
  reason: string
  riskLevel?: RiskLevel
  userAuthorization?: UserAuthorization
  confidence?: number
  reviewerSessionID?: string
  ssh?: Array<{
    destination: string
    port?: string
    remoteCommandSha256?: string
    stdinSource?: string
    stdinStatus?: string
    stdinReason?: string
  }>
}

export interface ApprovedAnnotation {
  requestID: string
  sessionID: string
  decision: ReviewDecision
}

export interface ReviewExecutionResult {
  kind: "allow" | "deny" | "escalate"
  decision?: ReviewDecision
  reason: string
  reviewSessionID?: string
}
