import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { resolveConfig } from "./config.ts"
import { ApprovalReviewerRuntime } from "./runtime.ts"
import { extractPermissionRequest } from "./opencode/event-normalizer.ts"
import { createV1Adapter } from "./opencode/v1-adapter.ts"
import type { RuntimeContext } from "./opencode/types.ts"
import { createAuditWriter } from "./audit.ts"

export const server: Plugin = async (input, options) => {
  const config = resolveConfig(options)
  const logger = config.debug
    ? (message: string, details?: unknown) => {
        console.error(`[opencode-permission-reviewer] ${message}`, details ?? "")
      }
    : undefined
  const writeAudit = createAuditWriter(config, logger)
  const ctx: RuntimeContext = {
    ...createV1Adapter({
      client: input.client,
      directory: input.directory,
      worktree: input.worktree,
    }),
    ...(writeAudit === undefined ? {} : { writeAudit }),
  }
  const runtime = new ApprovalReviewerRuntime(ctx, config, logger)

  return {
    event: async ({ event }) => {
      runtime.handlePermissionReply(event)
      const request = extractPermissionRequest(event)
      if (!request) return
      runtime.handle(request)
    },
    "tool.execute.after": async (event, output) => {
      runtime.annotateToolResult(event.callID, output)
    },
    dispose: async () => {
      await runtime.waitForIdle()
    },
  }
}

const module: PluginModule = {
  id: "opencode-permission-reviewer",
  server,
}

export default module
export { ApprovalReviewerRuntime } from "./runtime.ts"
export { extractPermissionRequest } from "./opencode/event-normalizer.ts"
export { resolveConfig } from "./config.ts"
export { parseDecision, enforceDecision, DECISION_SCHEMA } from "./decision.ts"
export { emergencyBrakeReason } from "./emergency-brake.ts"
export { redactSecrets } from "./redact.ts"
export { createUiStatus, decodeUiStatus, encodeUiStatus, permissionAction } from "./ui-protocol.ts"
export { ReviewUiState } from "./ui-state.ts"
export { createAuditWriter, DEFAULT_AUDIT_PATH } from "./audit.ts"
export { enrichSshEvidence } from "./ssh-evidence.ts"
export { enrichLocalScriptEvidence } from "./local-script-evidence.ts"
export { enrichGitEvidence } from "./git-evidence.ts"
export type * from "./types.ts"
