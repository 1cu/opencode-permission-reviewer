import type { OpenCodeCapabilities, PermissionReplyInput, RawTransport } from "./adapter.ts"

export interface ReplyTransport {
  reply(input: PermissionReplyInput): Promise<{ data?: unknown; error?: unknown }>
}

export interface ReplyTransportDeps {
  /** The v1 authenticated raw transport (`client._client`). May be undefined
   *  when the host client does not expose it; the factory throws in that case. */
  raw: RawTransport | undefined
  capabilities: OpenCodeCapabilities
  /** Emitted once when the transport is built, for diagnostics. */
  logOnce?: (message: string) => void
}

/**
 * Resolve how a permission reply is sent. The priority is: a public SDK reply
 * that can carry the feedback `message`, then a public reply plus a separate
 * feedback channel, then the authenticated raw transport, then refuse startup.
 *
 * In the OpenCode 1.18.x line the message-bearing reply is reachable ONLY via
 * the raw transport on a server plugin (the v1 client has no `permission.reply`
 * and the v2 client is not handed to server plugins yet), so the chain resolves
 * to raw today. The structure lets a public path slot in unchanged when a host
 * exposes one.
 */
export function createReplyTransport(deps: ReplyTransportDeps): ReplyTransport {
  const useRaw = deps.capabilities.rawAuthenticatedTransport && deps.raw !== undefined
  if (!useRaw) {
    throw new Error(
      "OpenCode's authenticated SDK transport is unavailable; refusing unsafe partial startup.",
    )
  }
  deps.logOnce?.(
    `permission reply transport ready: path=raw-authenticated capabilities=${JSON.stringify(deps.capabilities)}`,
  )
  return {
    async reply(input: PermissionReplyInput) {
      return deps.raw!.post({
        url: "/permission/{requestID}/reply",
        path: { requestID: input.requestID },
        body: {
          reply: input.reply,
          ...(input.message === undefined ? {} : { message: input.message }),
        },
        query: { directory: input.directory },
        headers: { "Content-Type": "application/json" },
      })
    },
  }
}
