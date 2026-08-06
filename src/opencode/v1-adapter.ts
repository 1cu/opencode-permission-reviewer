import { encodeUiStatus } from "../ui-protocol.ts"
import type { ReviewUiStatus } from "../ui-protocol.ts"
import type { OpenCodeClientLike, RuntimeContext } from "./types.ts"

/**
 * The authenticated raw transport OpenCode hands to plugins under
 * `input.client._client`. Only `post` is exercised today (permission replies
 * and TUI status publishing); it carries the host's auth context, which is why
 * a typed client cannot be constructed by the plugin itself.
 */
interface RawTransport {
  post(options: unknown): Promise<{ data?: unknown; error?: unknown }>
}

interface V1ServerInput {
  client: unknown
  directory: string
  worktree: string
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
  const permissionReply: RuntimeContext["permissionReply"] = (request) =>
    transport.post({
      url: "/permission/{requestID}/reply",
      ...(request as Record<string, unknown>),
      headers: { "Content-Type": "application/json" },
    })
  const publishUiStatus = (status: ReviewUiStatus) =>
    transport.post({
      url: "/tui/publish",
      body: {
        type: "tui.command.execute",
        properties: { command: encodeUiStatus(status) },
      },
      query: { directory: input.directory },
      headers: { "Content-Type": "application/json" },
    })

  return {
    client,
    permissionReply,
    publishUiStatus,
    directory: input.directory,
    worktree: input.worktree,
  }
}
