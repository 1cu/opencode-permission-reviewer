import type { PermissionRequest } from "../types.ts"

/**
 * Normalize a raw OpenCode event into a {@link PermissionRequest}.
 *
 * Returns `undefined` for anything that is not a well-formed
 * `permission.asked` event, so callers can ignore irrelevant events without
 * inspecting their shape.
 */
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
  // `always` is parsed for forward compatibility (a future "persist this
  // approval" surface) but is not consumed by the reviewer yet.
  void always
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
