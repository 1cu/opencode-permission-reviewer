import type { PermissionRequest, ReviewEnvelope, ReviewerConfig } from "../types.ts"
import { buildIntentHistory, buildTranscript, normalizeMessages } from "../context.ts"
import type { OpenCodeClientLike } from "../opencode/types.ts"
import { responseData } from "../opencode/transport.ts"
import { resolveActorContext } from "./actor-resolver.ts"
import type { EvidenceProvider } from "../evidence/provider.ts"
import type { SshAuditSummary } from "../ssh-evidence.ts"
import { SshEvidenceProvider } from "../evidence/ssh-provider.ts"
import { LocalScriptEvidenceProvider } from "../evidence/local-script-provider.ts"
import { GitEvidenceProvider } from "../evidence/git-provider.ts"

export interface EvidenceAssemblyContext {
  client: OpenCodeClientLike
  directory: string
  worktree: string
  config: ReviewerConfig
}

/**
 * Fetch the session transcript and run every evidence provider concurrently,
 * then fold the fragments into a single {@link ReviewEnvelope}. This is the
 * only place that decides which evidence text reaches the reviewer prompt and
 * which ssh audit summary reaches the audit record.
 */
export async function assembleEvidence(
  request: PermissionRequest,
  providers: EvidenceProvider[],
  ctx: EvidenceAssemblyContext,
): Promise<ReviewEnvelope> {
  const response = await ctx.client.session.messages({
    path: { id: request.sessionID },
    query: {
      directory: ctx.directory,
      limit: Math.max(ctx.config.historyMessages, ctx.config.transcriptMessages * 2, 20),
    },
  })
  const messages = normalizeMessages(responseData(response, "session.messages"))

  // Resolve actor/lineage/intent. The resolver is resilient — it never throws,
  // degrading to "unknown" — so this cannot block a review.
  const actor = await resolveActorContext(request, messages, ctx.client, ctx.directory, ctx.config)

  const fragments = await Promise.all(
    providers.map((provider) =>
      provider.collect({
        request,
        directory: ctx.directory,
        worktree: ctx.worktree,
        maxChars: ctx.config.maxEnrichmentChars,
      }),
    ),
  )

  const enrichment = fragments
    .map((fragment) => fragment.text)
    .filter(Boolean)
    .join("\n\n")

  const sshFragment = fragments.find((fragment) => fragment.kind === "ssh")
  const sshAudit: SshAuditSummary[] = sshFragment?.audit ?? []
  const preflightDenial = fragments.find(
    (fragment) => fragment.preflightDenial !== undefined,
  )?.preflightDenial

  return {
    request,
    directory: ctx.directory,
    worktree: ctx.worktree,
    transcript: buildTranscript(messages, ctx.config),
    intentHistory: buildIntentHistory(messages, ctx.config),
    enrichment,
    sshAudit,
    ...(preflightDenial === undefined ? {} : { preflightDenial }),
    actor: actor.actor,
    lineage: actor.lineage,
    intent: actor.intent,
    evidenceCompleteness: actor.completeness,
  }
}

/** The default evidence bundle used when callers do not inject their own. */
export function defaultEvidenceProviders(): EvidenceProvider[] {
  return [new SshEvidenceProvider(), new LocalScriptEvidenceProvider(), new GitEvidenceProvider()]
}
