import type { OpenCodeCapabilities } from "./adapter.ts"

/**
 * Probe what the host client actually exposes. Every check is a property-type
 * test on the client object; nothing is invoked, so the probe is safe to run at
 * startup and never throws. The result drives the reply-transport priority
 * chain and is surfaced to diagnostics.
 */
export function probeCapabilities(client: unknown): OpenCodeCapabilities {
  const record = (client ?? {}) as Record<string, unknown>
  const session = (record.session ?? {}) as Record<string, unknown>
  const tui = (record.tui ?? {}) as Record<string, unknown>
  const permission = (record.permission ?? {}) as Record<string, unknown>
  const raw = (record._client ?? {}) as Record<string, unknown>
  // The v2-generation client exposes permission.reply and names its protected
  // transport `client` (not `_client`). The v1 server client handed to plugins
  // today has neither a permission namespace nor permission.reply.
  const isV2Generation = typeof permission.reply === "function" && typeof raw.post !== "function"
  return {
    publicPermissionReply:
      typeof permission.reply === "function" ||
      typeof record.postSessionIdPermissionsPermissionId === "function",
    permissionReplyMessage: typeof permission.reply === "function",
    rawAuthenticatedTransport: typeof raw.post === "function",
    sessionGet: typeof session.get === "function",
    // Session.parentID exists in both SDK generations; the cheapest sound proxy
    // for whether lineage traversal can resolve parents is session.get itself.
    sessionParentID: typeof session.get === "function",
    // v1 carries agent only on UserMessage; v2 optionally on Session and both
    // roles. The resolver still guards per-message with its own type checks.
    assistantAgentMetadata: isV2Generation,
    // Session.mode exists in neither generation; message-level info.mode is out
    // of reach of this field. Reported as false until a host exposes it.
    assistantModeMetadata: false,
    // v1 has no effective-rules surface; v2 has only an optional per-session
    // ruleset. Reported from the probe shape, not assumed.
    effectivePermissions: isV2Generation,
    tuiPublish: typeof tui.publish === "function",
  }
}
