import type {
  ActorContext,
  ApprovedAnnotation,
  CapabilityAssessment,
  PermissionRequest,
  PolicyTrace,
  ReviewDecision,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewAuditRecord,
  ReviewerConfig,
} from "../types.ts"
import { buildEvidence } from "../context.ts"
import {
  DECISION_SCHEMA,
  DECISION_SCHEMA_VERSION,
  enforceDecision,
  parseDecision,
} from "../decision.ts"
import {
  DEFAULT_TENANT_POLICY,
  REVIEWER_PROMPT_VERSION,
  REVIEWER_SYSTEM_PROMPT,
  buildReviewerPrompt,
} from "../policy.ts"
import { emergencyBrakeReason } from "../emergency-brake.ts"
import { evaluatePolicy } from "../policy/policy-engine.ts"
import { splitModel } from "../config.ts"
import { createUiStatus, type ReviewUiStatus } from "../ui-protocol.ts"
import type { SshAuditSummary } from "../ssh-evidence.ts"
import { redactSecrets } from "../redact.ts"
import type { RuntimeContext } from "../opencode/types.ts"
import {
  extractStructured,
  isAlreadyResolvedError,
  responseData,
  withTimeout,
} from "../opencode/transport.ts"
import type { EvidenceProvider } from "../evidence/provider.ts"
import { assembleEvidence, defaultEvidenceProviders } from "../context/evidence-assembler.ts"

type Logger = (message: string, details?: unknown) => void

function approvedNote(decisions: ApprovedAnnotation[]): string {
  const lines = decisions.map(({ decision }) => {
    const confidence = `${Math.round(decision.confidence * 100)}%`
    return `- ${decision.risk_level} risk, ${decision.user_authorization} authorization, ${confidence} confidence: ${decision.rationale}`
  })
  return `[Automatic permission review approved this action once]\n${lines.join("\n")}`
}

/**
 * Owns the review lifecycle for permission requests: orchestration, the
 * supersede/annotation state machines, and the model call. The adapter
 * (transport) and the evidence providers are injected so this class stays
 * focused on ordering and races.
 */
export class ReviewCoordinator {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly reviewerSessions = new Set<string>()
  private readonly approvedByCall = new Map<string, ApprovedAnnotation[]>()
  private readonly sshAuditByRequest = new Map<string, SshAuditSummary[]>()
  // Bridge for the resolved actor context, mirroring sshAuditByRequest: the
  // envelope holds it for the reviewer prompt, audit() runs after the model
  // call and reads the per-request bridge so both paths observe the same actor.
  private readonly actorByRequest = new Map<string, ActorContext>()
  // Bridge for the capability assessment: same lifecycle as the actor/sshAudit
  // bridges (set in collectEnvelope, read in audit(), cleared in process).
  private readonly capabilityByRequest = new Map<string, CapabilityAssessment>()
  // Bridge for the policy trace (same lifecycle as the other bridges).
  private readonly policyTraceByRequest = new Map<string, PolicyTrace>()
  /**
   * Request IDs that a human (or any other reply source) resolved while the
   * automatic review was still in flight. The in-flight review must then give
   * up silently: no `emit`, no `reply`, and no `annotateToolResult`. OpenCode
   * resolves a request on a first-writer basis, so a late programmatic reply
   * returns 404 PermissionNotFoundError — we treat that the same way.
   */
  private readonly resolvedManually = new Set<string>()
  private readonly log: Logger
  private readonly providers: EvidenceProvider[]

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: ReviewerConfig,
    logger?: Logger,
    providers?: EvidenceProvider[],
  ) {
    this.log = logger ?? (() => {})
    this.providers = providers ?? defaultEvidenceProviders()
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
      this.actorByRequest.delete(request.id)
      this.capabilityByRequest.delete(request.id)
      this.policyTraceByRequest.delete(request.id)
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

    // Evaluate the declarative policy (Layer B). In observe mode this produces
    // a trace for audit only; in enforce mode a manual/deny route skips the LLM.
    const policyTrace = evaluatePolicy(
      envelope.capability,
      envelope.actor,
      this.config,
      this.config.policyRules,
    )
    this.policyTraceByRequest.set(request.id, policyTrace)
    if (this.config.enforcementMode === "enforce") {
      if (policyTrace.finalRoute === "manual") {
        const reason = `Declarative policy route: manual. ${policyTrace.matchedRules.map((m) => m.reason).join("; ")}`
        return { kind: "escalate", reason }
      }
      if (policyTrace.finalRoute === "deny") {
        const reason = `Declarative policy route: deny. ${policyTrace.matchedRules.map((m) => m.reason).join("; ")}`
        const decision: ReviewDecision = {
          outcome: "deny",
          risk_level: "high",
          user_authorization: "unknown",
          rationale: reason,
          confidence: 1,
        }
        const superseded = await this.denyAndReply(request, reason, decision)
        if (superseded) return superseded
        return { kind: "deny", reason, decision }
      }
    }

    const reviewed = await this.runReviewer(envelope)

    if (reviewed.kind === "allow" && reviewed.decision) {
      // A manual reply arriving during the model call supersedes the review:
      // do NOT stage an annotation or reply, and do NOT emit a UI phase.
      if (this.isSuperseded(request)) return this.supersedeResult()
      let annotation: ApprovedAnnotation | undefined
      if (request.tool?.callID) {
        const current = this.approvedByCall.get(request.tool.callID) ?? []
        annotation = {
          requestID: request.id,
          sessionID: request.sessionID,
          decision: reviewed.decision,
        }
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
        const remaining = annotations.filter(
          (annotation) => annotation.sessionID !== properties.sessionID,
        )
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
    const envelope = await assembleEvidence(request, this.providers, {
      client: this.ctx.client,
      directory: this.ctx.directory,
      worktree: this.ctx.worktree,
      config: this.config,
    })
    // Bridge the ssh audit summary from the envelope to the audit() call. The
    // envelope carries sshAudit for the reviewer prompt; audit() runs after the
    // model call and reads the per-request bridge so both the success and the
    // error-path audits observe the same ssh summary.
    this.sshAuditByRequest.set(request.id, envelope.sshAudit)
    if (envelope.actor !== undefined) this.actorByRequest.set(request.id, envelope.actor)
    if (envelope.capability !== undefined) {
      this.capabilityByRequest.set(request.id, envelope.capability)
    }
    return envelope
  }

  private async audit(
    request: PermissionRequest,
    result: ReviewExecutionResult,
    startedAt: number,
  ): Promise<void> {
    if (!this.ctx.writeAudit) return
    const decision = result.decision
    const ssh = this.sshAuditByRequest.get(request.id)
    const actor = this.actorByRequest.get(request.id)
    const capability = this.capabilityByRequest.get(request.id)
    const policyTrace = this.policyTraceByRequest.get(request.id)
    const record: ReviewAuditRecord = {
      schemaVersion: 1,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      promptVersion: REVIEWER_PROMPT_VERSION,
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
      ...(result.reviewSessionID === undefined
        ? {}
        : { reviewerSessionID: result.reviewSessionID }),
      ...(actor === undefined
        ? {}
        : {
            rootSessionID: actor.rootSessionID.value,
            actor: {
              ...(actor.agentName.value === undefined ? {} : { name: actor.agentName.value }),
              ...(actor.mode.value === undefined ? {} : { mode: actor.mode.value }),
              profile: actor.profile.value,
              identityCompleteness: actor.identityCompleteness,
              delegationDepth: actor.delegationDepth.value,
            },
          }),
      ...(!ssh?.length ? {} : { ssh }),
      ...(capability === undefined
        ? {}
        : {
            capability: {
              actionClass: capability.actionClass.value,
              summary: capability.summary,
              parserCompleteness: capability.parserCompleteness,
              ...(capability.executesCode.value === true ? { executesCode: true } : {}),
              ...(capability.createsAdHocCode.value === true ? { createsAdHocCode: true } : {}),
              ...(capability.invokesPackageLifecycleScripts.value === true
                ? { invokesPackageLifecycleScripts: true }
                : {}),
              writeEffects: {
                ...(capability.writeEffects.temporaryWrite.value === true
                  ? { temporaryWrite: true }
                  : {}),
                ...(capability.writeEffects.workspaceWrite.value === true
                  ? { workspaceWrite: true }
                  : {}),
                ...(capability.writeEffects.externalWrite.value === true
                  ? { externalWrite: true }
                  : {}),
                ...(capability.writeEffects.deletion.value === true ? { deletion: true } : {}),
              },
              ...(capability.network.observed.value === true ? { networkObserved: true } : {}),
              ...(capability.process.privilegeEscalation.value === true
                ? { privilegeEscalation: true }
                : {}),
              ...(capability.process.persistence.value === true ? { persistence: true } : {}),
              ...(capability.remote.enabled.value === true ? { remoteEnabled: true } : {}),
              ...(capability.git.possible.value === true ? { gitMutation: true } : {}),
            },
          }),
      ...(policyTrace === undefined
        ? {}
        : {
            policyTrace: {
              effectivePolicyHash: policyTrace.effectivePolicyHash,
              matchedRules: policyTrace.matchedRules,
              finalRoute: policyTrace.finalRoute,
              mode: policyTrace.mode,
            },
          }),
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
      if (typeof created.id !== "string")
        throw new Error("session.create returned an invalid session ID")
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
            // The role, safety rules, and anti-prompt-injection guidance live
            // in the system prompt so they carry system-level priority over the
            // untrusted evidence passed in the part below.
            system: REVIEWER_SYSTEM_PROMPT,
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
    const actor = this.actorByRequest.get(request.id)
    const status = createUiStatus(request, phase, {
      model: this.config.model,
      variant: this.config.variant,
      timeoutMs: this.config.timeoutMs,
      ...(reason === undefined ? {} : { reason }),
      ...(decision === undefined ? {} : { decision }),
      ...(actor?.agentName.value === undefined ? {} : { actorName: actor.agentName.value }),
      ...(actor === undefined ? {} : { actorProfile: actor.profile.value }),
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
