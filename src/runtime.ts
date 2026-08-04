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
        const reason = error instanceof Error ? error.message : String(error)
        await this.emit(request, "manual", reason)
        this.log("review failed; leaving request for manual approval", {
          requestID: request.id,
          error: reason,
        })
      })
      .finally(() => {
        this.pending.delete(request.id)
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

  private async processRequest(request: PermissionRequest): Promise<ReviewExecutionResult> {
    await this.emit(request, "reviewing")

    if (this.reviewerSessions.has(request.sessionID)) {
      const reason = "Automatic reviewer sessions may not request additional permissions."
      await this.emit(request, "denied", reason)
      await this.reply(request, "reject", reason)
      return { kind: "deny", reason }
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
      await this.emit(request, "denied", brake, decision)
      await this.reply(request, "reject", brake)
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
      await this.emit(request, "denied", envelope.preflightDenial, decision)
      await this.reply(request, "reject", envelope.preflightDenial)
      return { kind: "deny", reason: envelope.preflightDenial, decision }
    }
    const reviewed = await this.runReviewer(envelope)

    if (reviewed.kind === "allow" && reviewed.decision) {
      let annotation: ApprovedAnnotation | undefined
      if (request.tool?.callID) {
        const current = this.approvedByCall.get(request.tool.callID) ?? []
        annotation = { requestID: request.id, sessionID: request.sessionID, decision: reviewed.decision }
        current.push(annotation)
        this.approvedByCall.set(request.tool.callID, current)
      }
      try {
        await this.emit(request, "approved", reviewed.reason, reviewed.decision)
        await this.reply(request, "once")
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
      await this.emit(request, "denied", reviewed.reason, reviewed.decision)
      await this.reply(request, "reject", reviewed.reason)
      return reviewed
    }

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
    if (!properties || properties.reply !== "reject" || typeof properties.sessionID !== "string") return

    for (const [callID, annotations] of this.approvedByCall) {
      const remaining = annotations.filter((annotation) => annotation.sessionID !== properties.sessionID)
      if (remaining.length === 0) this.approvedByCall.delete(callID)
      else if (remaining.length !== annotations.length) this.approvedByCall.set(callID, remaining)
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
            title: `[permission-review] ${envelope.request.permission}: ${envelope.request.patterns.join(", ").slice(0, 120)}`,
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

  private async reply(request: PermissionRequest, reply: "once" | "reject", message?: string): Promise<void> {
    const response = await this.ctx.permissionReply({
      path: { requestID: request.id },
      body: {
        reply,
        ...(message === undefined ? {} : { message: `[Automatic permission review] ${message}` }),
      },
      query: { directory: this.ctx.directory },
    })
    responseData(response, "permission.reply")
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
