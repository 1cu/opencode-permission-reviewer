import type {
  ApprovedAnnotation,
  MessageWithParts,
  PermissionRequest,
  ReviewDecision,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewAuditRecord,
  ReviewerConfig,
} from "./types.ts"
import { buildEvidence, buildIntentHistory, buildTranscript, normalizeMessages } from "./context.ts"
import { DECISION_SCHEMA, enforceDecision, parseDecision } from "./decision.ts"
import { DEFAULT_TENANT_POLICY, buildReviewerPrompt } from "./policy.ts"
import { emergencyBrakeReason } from "./emergency-brake.ts"
import { splitModel } from "./config.ts"
import { createUiStatus, type ReviewUiStatus } from "./ui-protocol.ts"
import { enrichSshEvidence, type SshAuditSummary } from "./ssh-evidence.ts"
import { enrichLocalScriptEvidence } from "./local-script-evidence.ts"
import { enrichGitEvidence } from "./git-evidence.ts"
import { redactSecrets } from "./redact.ts"

interface ClientResponse<T> {
  data?: T
  error?: unknown
}

export interface OpenCodeClientLike {
  session: {
    create(options: unknown): Promise<ClientResponse<Record<string, unknown>>>
    messages(options: unknown): Promise<ClientResponse<unknown>>
    prompt(options: unknown): Promise<ClientResponse<Record<string, unknown>>>
    delete?(options: unknown): Promise<ClientResponse<unknown>>
  }
  tool: {
    ids(options?: unknown): Promise<ClientResponse<string[]>>
  }
}

export interface RuntimeContext {
  client: OpenCodeClientLike
  permissionReply(options: unknown): Promise<ClientResponse<unknown>>
  publishUiStatus?(status: ReviewUiStatus): Promise<ClientResponse<unknown>>
  writeAudit?(record: ReviewAuditRecord): Promise<void>
  directory: string
  worktree: string
}

type Logger = (message: string, details?: unknown) => void

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Reviewer timed out after ${timeoutMs}ms`)), timeoutMs)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function responseData<T>(response: ClientResponse<T>, label: string): T {
  if (response.error !== undefined) throw new Error(`${label} failed: ${JSON.stringify(response.error)}`)
  if (response.data === undefined) throw new Error(`${label} returned no data`)
  return response.data
}

function extractStructured(response: Record<string, unknown>): unknown {
  const info = response.info
  if (typeof info !== "object" || info === null) return
  return (info as Record<string, unknown>).structured
}

function approvedNote(decisions: ApprovedAnnotation[]): string {
  const lines = decisions.map(({ decision }) => {
    const confidence = `${Math.round(decision.confidence * 100)}%`
    return `- ${decision.risk_level} risk, ${decision.user_authorization} authorization, ${confidence} confidence: ${decision.rationale}`
  })
  return `[Automatic permission review approved this action once]\n${lines.join("\n")}`
}

export class ApprovalReviewerRuntime {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly reviewerSessions = new Set<string>()
  private readonly approvedByCall = new Map<string, ApprovedAnnotation[]>()
  private readonly sshAuditByRequest = new Map<string, SshAuditSummary[]>()
  /**
   * Request IDs that a human (or any other reply source) resolved while the
   * automatic review was still in flight. The in-flight review must then give
   * up silently: no `emit`, no `reply`, and no `annotateToolResult`. OpenCode
   * resolves a request on a first-writer basis, so a late programmatic reply
   * returns 404 PermissionNotFoundError — we treat that the same way.
   */
  private readonly resolvedManually = new Set<string>()
  private readonly log: Logger

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: ReviewerConfig,
    logger?: Logger,
  ) {
    this.log = logger ?? (() => {})
  }

  isReviewerSession(sessionID: string): boolean {
    return this.reviewerSessions.has(sessionID)
  }

  pendingCount(): number {
    return this.pending.size
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
  }

  handle(request: PermissionRequest): void {
    if (this.pending.has(request.id)) return

    const task = this.process(request)
      .catch(async (error) => {
        // If the request was answered manually while we were gathering context
        // (or racing with the model), do not resurrect it as "manual" — that
        // would re-prompt the user for a request the server has already closed.
        if (this.isSuperseded(request)) return
        const reason = error instanceof Error ? error.message : String(error)
        await this.emit(request, "manual", reason)
        this.log("review failed; leaving request for manual approval", {
          requestID: request.id,
          error: reason,
        })
      })
      .finally(() => {
        this.pending.delete(request.id)
        // Prune so the set cannot grow unboundedly across a long session.
        this.resolvedManually.delete(request.id)
      })
    this.pending.set(request.id, task)
  }

  async process(request: PermissionRequest): Promise<ReviewExecutionResult> {
    const startedAt = Date.now()
    try {
      const result = await this.processRequest(request)
      await this.audit(request, result, startedAt)
      return result
    } catch (error) {
      await this.audit(
        request,
        {
          kind: "escalate",
          reason: error instanceof Error ? error.message : String(error),
        },
        startedAt,
      )
      throw error
    } finally {
      this.sshAuditByRequest.delete(request.id)
    }
  }

  private supersedeResult(): ReviewExecutionResult {
    return {
      kind: "escalate",
      reason: "Request already answered manually; automatic review superseded.",
    }
  }

  private isSuperseded(request: PermissionRequest): boolean {
    return this.resolvedManually.has(request.id)
  }

  /**
   * Reject a request with `reject` while honoring supersede. Returns `undefined`
   * when the rejection was applied, or the supersede result when the request had
   * already been answered manually (so the caller returns it unchanged).
   */
  private async denyAndReply(
    request: PermissionRequest,
    reason: string,
    decision?: ReviewDecision,
  ): Promise<ReviewExecutionResult | undefined> {
    if (this.isSuperseded(request)) return this.supersedeResult()
    await this.emit(request, "denied", reason, decision)
    if (this.isSuperseded(request)) return this.supersedeResult()
    const accepted = await this.safeReply(request, "reject", reason)
    if (!accepted) return this.supersedeResult()
    return undefined
  }

  private async processRequest(request: PermissionRequest): Promise<ReviewExecutionResult> {
    await this.emit(request, "reviewing")

    if (this.reviewerSessions.has(request.sessionID)) {
      const reason = "Automatic reviewer sessions may not request additional permissions."
      const decision: ReviewDecision = {
        outcome: "deny",
        risk_level: "critical",
        user_authorization: "unknown",
        rationale: reason,
        confidence: 1,
      }
      const superseded = await this.denyAndReply(request, reason, decision)
      if (superseded) return superseded
      return { kind: "deny", reason, decision }
    }

    const brake = emergencyBrakeReason(request)
    if (brake) {
      const decision: ReviewDecision = {
        outcome: "deny",
        risk_level: "critical",
        user_authorization: "unknown",
        rationale: brake,
        confidence: 1,
      }
      const superseded = await this.denyAndReply(request, brake, decision)
      if (superseded) return superseded
      return { kind: "deny", reason: brake, decision }
    }

    const envelope = await this.collectEnvelope(request)
    if (envelope.preflightDenial) {
      const decision: ReviewDecision = {
        outcome: "deny",
        risk_level: "high",
        user_authorization: "unknown",
        rationale: envelope.preflightDenial,
        confidence: 1,
      }
      const superseded = await this.denyAndReply(request, envelope.preflightDenial, decision)
      if (superseded) return superseded
      return { kind: "deny", reason: envelope.preflightDenial, decision }
    }
    // A manual reply arriving during context collection (transcript, git, ssh)
    // supersedes the review before we spend a model call on it.
    if (this.isSuperseded(request)) return this.supersedeResult()
    const reviewed = await this.runReviewer(envelope)

    if (reviewed.kind === "allow" && reviewed.decision) {
      // A manual reply arriving during the model call supersedes the review:
      // do NOT stage an annotation or reply, and do NOT emit a UI phase.
      if (this.isSuperseded(request)) return this.supersedeResult()
      let annotation: ApprovedAnnotation | undefined
      if (request.tool?.callID) {
        const current = this.approvedByCall.get(request.tool.callID) ?? []
        annotation = { requestID: request.id, sessionID: request.sessionID, decision: reviewed.decision }
        current.push(annotation)
        this.approvedByCall.set(request.tool.callID, current)
      }
      try {
        await this.emit(request, "approved", reviewed.reason, reviewed.decision)
        const accepted = await this.safeReply(request, "once")
        if (!accepted) {
          // Request was resolved by someone else; roll back the annotation.
          if (request.tool?.callID && annotation) {
            const current = this.approvedByCall.get(request.tool.callID) ?? []
            const remaining = current.filter((item) => item !== annotation)
            if (remaining.length === 0) this.approvedByCall.delete(request.tool.callID)
            else this.approvedByCall.set(request.tool.callID, remaining)
          }
          return this.supersedeResult()
        }
      } catch (error) {
        if (request.tool?.callID && annotation) {
          const current = this.approvedByCall.get(request.tool.callID) ?? []
          const remaining = current.filter((item) => item !== annotation)
          if (remaining.length === 0) this.approvedByCall.delete(request.tool.callID)
          else this.approvedByCall.set(request.tool.callID, remaining)
        }
        throw error
      }
      return reviewed
    }

    if (reviewed.kind === "deny") {
      const superseded = await this.denyAndReply(request, reviewed.reason, reviewed.decision)
      if (superseded) return superseded
      return reviewed
    }

    // Escalate (low confidence, invalid output, timeout, …). A manual reply
    // arriving during the model call supersedes here too: do not emit a "manual"
    // phase that would resurrect the request in the TUI after the human acted.
    if (this.isSuperseded(request)) return this.supersedeResult()
    await this.emit(request, "manual", reviewed.reason, reviewed.decision)
    this.log("review escalated to user", { requestID: request.id, reason: reviewed.reason })
    return reviewed
  }

  handlePermissionReply(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const record = event as Record<string, unknown>
    if (record.type !== "permission.replied") return
    const properties =
      typeof record.properties === "object" && record.properties !== null
        ? (record.properties as Record<string, unknown>)
        : undefined
    if (!properties || typeof properties.sessionID !== "string") return

    // Drop approval annotations when the human rejects the session's tool calls.
    if (properties.reply === "reject") {
      for (const [callID, annotations] of this.approvedByCall) {
        const remaining = annotations.filter((annotation) => annotation.sessionID !== properties.sessionID)
        if (remaining.length === 0) this.approvedByCall.delete(callID)
        else if (remaining.length !== annotations.length) this.approvedByCall.set(callID, remaining)
      }
    }

    // Any terminal reply (once | always | reject) to a request we are still
    // reviewing means the in-flight review is now superseded. OpenCode always
    // carries requestID (verified against the SDK V2 contract), so we key off
    // it and never fall back to the session (which could cancel sibling reviews).
    if (typeof properties.requestID === "string" && this.pending.has(properties.requestID)) {
      this.resolvedManually.add(properties.requestID)
    }
  }

  annotateToolResult(callID: string, output: { output?: unknown; metadata?: unknown }): void {
    const annotations = this.approvedByCall.get(callID)
    if (!annotations?.length) return
    this.approvedByCall.delete(callID)

    const note = approvedNote(annotations)
    if (typeof output.output === "string") {
      output.output = `${note}\n\n${output.output}`
    } else {
      output.output = `${note}\n\n${JSON.stringify(output.output)}`
    }
    const metadata =
      typeof output.metadata === "object" && output.metadata !== null
        ? (output.metadata as Record<string, unknown>)
        : {}
    metadata.approvalReviewer = annotations.map((annotation) => ({
      requestID: annotation.requestID,
      sessionID: annotation.sessionID,
      ...annotation.decision,
    }))
    output.metadata = metadata
  }

  private async collectEnvelope(request: PermissionRequest): Promise<ReviewEnvelope> {
    const response = await this.ctx.client.session.messages({
      path: { id: request.sessionID },
      query: {
        directory: this.ctx.directory,
        limit: Math.max(this.config.historyMessages, this.config.transcriptMessages * 2, 20),
      },
    })
    const messages = normalizeMessages(responseData(response, "session.messages"))
    const [sshEnrichment, localScriptEnrichment, gitEnrichment] = await Promise.all([
      enrichSshEvidence(
        request,
        this.ctx.directory,
        this.ctx.worktree,
        this.config.maxEnrichmentChars,
      ),
      enrichLocalScriptEvidence(
        request,
        this.ctx.directory,
        this.ctx.worktree,
        this.config.maxEnrichmentChars,
      ),
      enrichGitEvidence(request, this.ctx.directory, this.config.maxEnrichmentChars),
    ])
    this.sshAuditByRequest.set(request.id, sshEnrichment.audit)
    const enrichment = [sshEnrichment.text, localScriptEnrichment.text, gitEnrichment.text]
      .filter(Boolean)
      .join("\n\n")
    return {
      request,
      directory: this.ctx.directory,
      worktree: this.ctx.worktree,
      transcript: buildTranscript(messages, this.config),
      intentHistory: buildIntentHistory(messages, this.config),
      enrichment,
      sshAudit: sshEnrichment.audit,
      ...(sshEnrichment.preflightDenial === undefined
        ? {}
        : { preflightDenial: sshEnrichment.preflightDenial }),
    }
  }

  private async audit(
    request: PermissionRequest,
    result: ReviewExecutionResult,
    startedAt: number,
  ): Promise<void> {
    if (!this.ctx.writeAudit) return
    const decision = result.decision
    const ssh = this.sshAuditByRequest.get(request.id)
    const record: ReviewAuditRecord = {
      timestamp: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      requestID: request.id,
      sessionID: request.sessionID,
      permission: request.permission,
      outcome: result.kind,
      reason: result.reason,
      ...(decision === undefined
        ? {}
        : {
            riskLevel: decision.risk_level,
            userAuthorization: decision.user_authorization,
            confidence: decision.confidence,
          }),
      ...(result.reviewSessionID === undefined ? {} : { reviewerSessionID: result.reviewSessionID }),
      ...(!ssh?.length ? {} : { ssh }),
    }
    await this.ctx.writeAudit(record).catch((error) => {
      this.log("failed to write review audit", {
        requestID: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async runReviewer(envelope: ReviewEnvelope): Promise<ReviewExecutionResult> {
    const { providerID, modelID } = splitModel(this.config.model)
    let reviewSessionID: string | undefined

    try {
      const created = responseData(
        await this.ctx.client.session.create({
          body: {
            parentID: envelope.request.sessionID,
            title: `[permission-review] ${envelope.request.permission}: ${redactSecrets(
              envelope.request.patterns.join(", "),
            ).slice(0, 120)}`,
          },
          query: { directory: this.ctx.directory },
        }),
        "session.create",
      )
      if (typeof created.id !== "string") throw new Error("session.create returned an invalid session ID")
      reviewSessionID = created.id
      this.reviewerSessions.add(reviewSessionID)

      const toolIDs = responseData(
        await this.ctx.client.tool.ids({ query: { directory: this.ctx.directory } }),
        "tool.ids",
      )
      const tools = Object.fromEntries(toolIDs.map((id) => [id, false]))
      const policy = this.config.policy ?? DEFAULT_TENANT_POLICY
      const prompt = buildReviewerPrompt(policy, buildEvidence(envelope, this.config))

      const response = await withTimeout(
        this.ctx.client.session.prompt({
          path: { id: reviewSessionID },
          query: { directory: this.ctx.directory },
          body: {
            model: { providerID, modelID },
            variant: this.config.variant,
            tools,
            system: "You are a tool-free automatic permission reviewer. Follow the supplied review policy exactly.",
            format: {
              type: "json_schema",
              schema: DECISION_SCHEMA,
              retryCount: 2,
            },
            parts: [{ type: "text", text: prompt }],
          },
        }),
        this.config.timeoutMs,
      )
      const data = responseData(response, "session.prompt")
      const parsed = parseDecision(extractStructured(data))
      if (!parsed) {
        return {
          kind: "escalate",
          reason: "Reviewer returned missing or invalid structured output.",
          reviewSessionID,
        }
      }
      return { ...enforceDecision(parsed, this.config), reviewSessionID }
    } catch (error) {
      return {
        kind: "escalate",
        reason: error instanceof Error ? error.message : String(error),
        ...(reviewSessionID === undefined ? {} : { reviewSessionID }),
      }
    } finally {
      if (reviewSessionID !== undefined) {
        this.reviewerSessions.delete(reviewSessionID)
        if (!this.config.retainReviewSessions && this.ctx.client.session.delete) {
          await withTimeout(
            this.ctx.client.session.delete({
              path: { id: reviewSessionID },
              query: { directory: this.ctx.directory },
            }),
            Math.min(this.config.timeoutMs, 5_000),
          ).catch(() => {})
        }
      }
    }
  }

  /**
   * Send a permission reply. Returns `true` on success, `false` when the
   * request was already resolved by another source (human TUI, a duplicate
   * event, etc.) so the caller can treat itself as superseded. Other errors
   * (transport failure, malformed reply) are still thrown.
   */
  private async safeReply(
    request: PermissionRequest,
    reply: "once" | "reject",
    message?: string,
  ): Promise<boolean> {
    const response = await this.ctx.permissionReply({
      path: { requestID: request.id },
      body: {
        reply,
        ...(message === undefined ? {} : { message: `[Automatic permission review] ${message}` }),
      },
      query: { directory: this.ctx.directory },
    })
    if (response.error !== undefined) {
      if (isAlreadyResolvedError(response.error)) {
        this.resolvedManually.add(request.id)
        this.log("review reply rejected because the request was already resolved", {
          requestID: request.id,
          error: response.error,
        })
        return false
      }
      throw new Error(`permission.reply failed: ${JSON.stringify(response.error)}`)
    }
    return true
  }

  private async emit(
    request: PermissionRequest,
    phase: ReviewUiStatus["phase"],
    reason?: string,
    decision?: ReviewDecision,
  ): Promise<void> {
    if (!this.ctx.publishUiStatus) return
    const status = createUiStatus(request, phase, {
      model: this.config.model,
      variant: this.config.variant,
      timeoutMs: this.config.timeoutMs,
      ...(reason === undefined ? {} : { reason }),
      ...(decision === undefined ? {} : { decision }),
    })
    await this.ctx.publishUiStatus(status).catch((error) => {
      this.log("failed to publish reviewer UI status", {
        requestID: request.id,
        phase,
        error: error instanceof Error ? error.message : String(error),
      })
      return {}
    })
  }
}

export function extractPermissionRequest(event: unknown): PermissionRequest | undefined {
  if (typeof event !== "object" || event === null) return
  const record = event as Record<string, unknown>
  if (record.type !== "permission.asked") return
  const properties = record.properties
  if (typeof properties !== "object" || properties === null) return
  const request = properties as Record<string, unknown>
  if (typeof request.id !== "string" || typeof request.sessionID !== "string") return
  if (typeof request.permission !== "string" || !Array.isArray(request.patterns)) return

  const patterns = request.patterns.filter((item): item is string => typeof item === "string")
  if (patterns.length !== request.patterns.length) return
  const metadata =
    typeof request.metadata === "object" && request.metadata !== null
      ? (request.metadata as Record<string, unknown>)
      : {}
  const always = Array.isArray(request.always)
    ? request.always.filter((item): item is string => typeof item === "string")
    : []
  const tool =
    typeof request.tool === "object" &&
    request.tool !== null &&
    typeof (request.tool as Record<string, unknown>).messageID === "string" &&
    typeof (request.tool as Record<string, unknown>).callID === "string"
      ? {
          messageID: (request.tool as Record<string, unknown>).messageID as string,
          callID: (request.tool as Record<string, unknown>).callID as string,
        }
      : undefined

  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.permission,
    patterns,
    metadata,
    always,
    ...(tool === undefined ? {} : { tool }),
  }
}

export function normalizeMessageList(value: unknown): MessageWithParts[] {
  return normalizeMessages(value)
}

/**
 * Recognize the error shape OpenCode returns when a permission reply arrives
 * for a request that was already resolved (first-writer-wins). The server's
 * `PermissionNotFoundError` is HTTP 404; the raw SDK may surface it as a status
 * code, an error code, or a human-readable message.
 */
function isAlreadyResolvedError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  const status = record.status
  if (status === 404 || status === "404") return true
  const code = typeof record.code === "string" ? record.code : ""
  if (/PermissionNotFound|not_found|notfound|already_resolved/i.test(code)) return true
  const message = typeof record.message === "string" ? record.message : ""
  // Match the OpenCode PermissionNotFoundError class and its common phrasings.
  // No `\b` so camelCase "PermissionNotFoundError" and "notfound" still match.
  return /PermissionNotFound|not\s*found|no\s+longer\s+(?:pending|exist)s?|already\s+(?:been\s+)?(?:resolved|answered|replied|closed)/i.test(
    message,
  )
}
