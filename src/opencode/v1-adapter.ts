import { encodeUiStatus } from "../ui-protocol.ts"
import type { OpenCodeClientLike, RuntimeContext } from "./types.ts"

/**
 * The authenticated raw transport OpenCode hands to plugins under
 * `input.client._client`. Only `post` is exercised for permission replies,
 * because the typed v1 permission method does not carry the reviewer feedback
 * `message` (confirmed against OpenCode 1.18.x — the message-bearing reply is
 * v2-only). TUI status publishing uses the typed v1 `client.tui.publish` API.
 */
interface RawTransport {
  post(options: unknown): Promise<{ data?: unknown; error?: unknown }>
}

interface V1ServerInput {
  client: unknown
  directory: string
  worktree: string
}

/** Typed v1 TUI publish shape (matches `TuiPublishData` in the SDK). */
interface TypedTuiPublish {
  (options: {
    body: { type: string; properties: { command: string } }
    query?: { directory?: string }
  }): Promise<unknown>
}

/**
 * Build the V1 {@link RuntimeContext} against OpenCode's authenticated raw
 * transport. Throws on partial startup when the transport is unavailable, so
 * the plugin never runs with an unauthenticated (and therefore unsafe) client.
 */
export function createV1Adapter(input: V1ServerInput): RuntimeContext {
  const transport = (input.client as { _client?: RawTransport })._client
  if (!transport?.post) {
    throw new Error(
      "OpenCode's authenticated SDK transport is unavailable; refusing unsafe partial startup.",
    )
  }

  const client = input.client as unknown as OpenCodeClientLike

  // Permission reply stays on the raw transport: the typed v1 method
  // (postSessionIdPermissionsPermissionId) does not carry the feedback message.
  const permissionReply: RuntimeContext["permissionReply"] = (request) =>
    transport.post({
      url: "/permission/{requestID}/reply",
      ...(request as Record<string, unknown>),
      headers: { "Content-Type": "application/json" },
    })

  // TUI status publishing uses the typed v1 API (client.tui.publish), which
  // carries the same body shape the raw transport used. Falls back to raw if
  // the typed method is absent in a future/older host. The method MUST be
  // called on the `tui` object (not extracted) because the SDK uses `this` to
  // reach its internal transport.
  const tui = (input.client as { tui?: { publish?: TypedTuiPublish } }).tui
  const publishUiStatus: RuntimeContext["publishUiStatus"] = (status) => {
    const body = {
      type: "tui.command.execute",
      properties: { command: encodeUiStatus(status) },
    }
    if (tui !== undefined && typeof tui.publish === "function") {
      return tui.publish({ body, query: { directory: input.directory } }) as Promise<{
        data?: unknown
        error?: unknown
      }>
    }
    return transport.post({
      url: "/tui/publish",
      body,
      query: { directory: input.directory },
      headers: { "Content-Type": "application/json" },
    })
  }

  return {
    client,
    permissionReply,
    publishUiStatus,
    directory: input.directory,
    worktree: input.worktree,
  }
}
