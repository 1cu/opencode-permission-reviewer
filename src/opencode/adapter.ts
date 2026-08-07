/**
 * Shared types for the OpenCode transport layer.
 *
 * The host hands the plugin a client object whose exact shape depends on the
 * OpenCode SDK generation (the v1 server client today, a v2 client eventually).
 * Capability detection probes that shape once at startup so the rest of the
 * plugin degrades conservatively when a feature is absent instead of trusting
 * a field that may not exist.
 */

/** Authenticated raw transport exposed by the host client under `_client`. */
export interface RawTransport {
  post(options: unknown): Promise<{ data?: unknown; error?: unknown }>
}

/** What the plugin learned about the host client at startup. */
export interface OpenCodeCapabilities {
  /** A public SDK method to answer a permission request exists. */
  publicPermissionReply: boolean
  /** That public method can carry a free-text feedback `message`. */
  permissionReplyMessage: boolean
  /** The authenticated raw `_client.post` transport is reachable. */
  rawAuthenticatedTransport: boolean
  /** `client.session.get` is available (lineage walking depends on it). */
  sessionGet: boolean
  /** Session records expose a `parentID` (lineage traversal). */
  sessionParentID: boolean
  /** Assistant messages carry an `agent` field (actor identity). */
  assistantAgentMetadata: boolean
  /** Assistant messages carry a `mode` field (actor identity). */
  assistantModeMetadata: boolean
  /** Effective permission rules can be resolved per session. */
  effectivePermissions: boolean
  /** `client.tui.publish` is available for status broadcasting. */
  tuiPublish: boolean
}

/** Flat reply input. The transport maps it back onto the SDK wire shape. */
export interface PermissionReplyInput {
  requestID: string
  reply: "once" | "always" | "reject"
  message?: string
  directory: string
}
