import type { PermissionRequest } from "../types.ts"

/**
 * Recover the shell command a permission request is about. Prefer the explicit
 * `command` metadata (set by the bash tool) and fall back to the patterns
 * joined as separate commands so analyzers still see the tokens.
 */
export function sourceCommand(request: PermissionRequest): string {
  const command = request.metadata.command
  if (typeof command === "string" && command.trim()) return command
  return request.patterns.join(" ; ")
}
