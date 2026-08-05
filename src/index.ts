import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { resolveConfig } from "./config.ts"
import { ApprovalReviewerRuntime, extractPermissionRequest } from "./runtime.ts"
import { encodeUiStatus } from "./ui-protocol.ts"
import { createAuditWriter } from "./audit.ts"

export const server: Plugin = async (input, options) => {
  const config = resolveConfig(options)
  const logger = config.debug
    ? (message: string, details?: unknown) => {
        console.error(`[opencode-permission-reviewer] ${message}`, details ?? "")
      }
    : undefined
  const writeAudit = createAuditWriter(config, logger)
  const transport = (input.client as unknown as {
    _client?: {
      post(options: unknown): Promise<{ data?: unknown; error?: unknown }>
    }
  })._client
  if (!transport?.post) {
    throw new Error("OpenCode's authenticated SDK transport is unavailable; refusing unsafe partial startup.")
  }

  const runtime = new ApprovalReviewerRuntime(
    {
      client: input.client as never,
      permissionReply: (request) =>
        transport.post({
          url: "/permission/{requestID}/reply",
          ...(request as Record<string, unknown>),
          headers: { "Content-Type": "application/json" },
        }),
      publishUiStatus: (status) =>
        transport.post({
          url: "/tui/publish",
          body: {
            type: "tui.command.execute",
            properties: { command: encodeUiStatus(status) },
          },
          query: { directory: input.directory },
          headers: { "Content-Type": "application/json" },
        }),
      ...(writeAudit === undefined ? {} : { writeAudit }),
      directory: input.directory,
      worktree: input.worktree,
    },
    config,
    logger,
  )

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
export { ApprovalReviewerRuntime, extractPermissionRequest } from "./runtime.ts"
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
