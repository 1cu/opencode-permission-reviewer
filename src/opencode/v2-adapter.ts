/**
 * Version gate for the host client.
 *
 * The v2-generation client exposes `permission.reply` (which carries the
 * feedback message) but is not handed to server plugins in the OpenCode 1.18.x
 * line. Until a host hands it over and the reply contract is verified, refuse
 * startup clearly instead of half-working against a client shape this plugin
 * was not built for.
 */
export function assertV1Host(client: unknown): void {
  const record = (client ?? {}) as Record<string, unknown>
  const permission = (record.permission ?? {}) as Record<string, unknown>
  const raw = (record._client ?? {}) as Record<string, unknown>
  if (typeof permission.reply === "function" && typeof raw.post !== "function") {
    throw new Error(
      "Detected an OpenCode v2-generation client (permission.reply is present). " +
        "opencode-permission-reviewer does not support OpenCode v2 hosts yet; " +
        "refusing startup. Run an OpenCode 1.18.x host.",
    )
  }
}
