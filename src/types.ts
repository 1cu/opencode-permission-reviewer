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
  /** When "observe", actor evidence is collected and audited but never enforces
   *  new gates; "enforce" is reserved for a later policy-engine release. */
  enforcementMode: "observe" | "enforce"
  /** Max hops when walking session parents (default 8). */
  maxSessionDepth: number
  /** Max parent sessions fetched during lineage traversal. */
  maxParentSessions: number
  /** Trusted name→profile mappings (empty by default; no mappings shipped). */
  actorProfiles: Record<string, ActorProfile>
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
  /** Agent-aware context (actor, lineage, intent). Observe-only: flows into the
   *  reviewer prompt and audit as evidence, never into enforcement decisions.
   *  Optional so older callers/tests still compile. */
  actor?: ActorContext
  lineage?: SessionLineage
  intent?: IntentContext
  evidenceCompleteness?: EvidenceCompleteness
}

export interface ReviewAuditRecord {
  /**
   * Audit schema version. Present on every record; readers default a missing
   * field to `1` (additive — old records are still valid).
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
  /** Root session of the request's ancestry (additive; absent when lineage was
   *  unavailable). */
  rootSessionID?: string
  /** Resolved actor snapshot for audit (additive). Uses identityCompleteness
   *  (not the decision's numeric confidence) to avoid field ambiguity. */
  actor?: {
    name?: string
    mode?: string
    profile: ActorProfile
    identityCompleteness: "complete" | "partial" | "unknown"
    delegationDepth?: number
  }
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

// ---------------------------------------------------------------------------
// Agent-aware context data model.
//
// These types carry actor/lineage/intent evidence alongside a permission
// request. They flow into the reviewer prompt (as evidence sections) and the
// audit record (additive fields) WITHOUT changing enforcement: the v1 decision
// schema and enforceDecision are untouched (observe-only by default).
// ---------------------------------------------------------------------------

/** Reliability of a derived fact. */
export type EvidenceConfidence = "confirmed" | "high" | "medium" | "low" | "unknown"

/** Every non-trivial derived fact carries provenance so the LLM and audit can
 *  weigh claims by how reliably they were established. */
export interface Provenanced<T> {
  value: T
  source:
    | "permission-event"
    | "tool-message"
    | "session-api"
    | "parent-session"
    | "global-config"
    | "project-config"
    | "effective-permissions"
    | "static-analysis"
    | "heuristic"
    | "unavailable"
  confidence: EvidenceConfidence
  notes?: string[]
}

/** Generic policy templates, NOT automatic trust levels. */
export type ActorProfile =
  "read-only" | "validation" | "workspace" | "operator" | "reviewer" | "unknown"

/** Normalized effective-permission summary when the SDK exposes it.
 *  The v1 SDK does not expose effective rules, so this stays `undefined`. */
export interface EffectivePermissionSummary {
  edit: "allow" | "ask" | "deny" | "mixed" | "unknown"
  bash: "allow" | "ask" | "deny" | "mixed" | "unknown"
  task: "allow" | "ask" | "deny" | "mixed" | "unknown"
  externalDirectory: "allow" | "ask" | "deny" | "mixed" | "unknown"
  source: "session" | "agent-config" | "derived" | "unknown"
}

/** Who is requesting the permission. */
export interface ActorContext {
  agentName: Provenanced<string | undefined>
  mode: Provenanced<string | undefined>
  profile: Provenanced<ActorProfile>
  sessionID: string
  parentSessionID: Provenanced<string | undefined>
  rootSessionID: Provenanced<string>
  delegationDepth: Provenanced<number>
  effectivePermissions?: EffectivePermissionSummary
  identityCompleteness: "complete" | "partial" | "unknown"
}

/** A node in the session ancestry chain. */
export interface SessionNode {
  sessionID: string
  parentID?: string
  title?: string
  version?: string
  actorName?: string
  mode?: string
  createdAt?: number
}

/** The resolved session ancestry with failure modes made explicit. */
export interface SessionLineage {
  nodes: SessionNode[]
  rootSessionID: string
  depth: number
  cycleDetected: boolean
  truncated: boolean
  missingParents: string[]
}

/** A single authorization/intent statement. */
export interface IntentBlock {
  sessionID: string
  messageID: string
  actor: "user" | "assistant" | "system" | "unknown"
  text: string
  synthetic: boolean
  createdAt?: number
  provenance: Provenanced<"intent">
}

/** Direct user intent kept separate from delegated task. */
export interface IntentContext {
  directUserIntent: IntentBlock[]
  delegatedTask: IntentBlock[]
  localSessionIntent: IntentBlock[]
  conflictingInstructions: string[]
  latestExplicitAuthorization?: IntentBlock
  completeness: "complete" | "partial" | "insufficient"
}

/** Meta-summary of what evidence was available. */
export interface EvidenceCompleteness {
  permission: boolean
  actor: boolean
  lineage: boolean
  directUserIntent: boolean
  delegatedTask: boolean
  capability: boolean
  repositoryState: boolean
  referencedCode: boolean
  reasons: string[]
  overall: "sufficient" | "partial" | "insufficient"
}
