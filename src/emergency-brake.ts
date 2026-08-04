import type { PermissionRequest } from "./types.ts"

const ROOT_DESTRUCTION = [
  /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\/(?:\s|$|[;&|])/,
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//i,
  /\bdd\b[^\n;&|]*\bof=\/dev\/(?:sd|nvme|vd|xvd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
]

const OBVIOUS_SECRET_EXPORT = [
  /\b(?:curl|wget|nc|ncat|socat)\b[^\n]*(?:\.ssh\/(?:id_|authorized_keys)|\.aws\/credentials|\.config\/gh\/hosts\.yml)/i,
  /\b(?:curl|wget|nc|ncat|socat)\b[^\n]*(?:api[_-]?key|access[_-]?token|private[_-]?key|session[_-]?cookie)/i,
]

export function emergencyBrakeReason(request: PermissionRequest): string | undefined {
  if (request.permission !== "bash") return
  const command =
    typeof request.metadata.command === "string"
      ? request.metadata.command
      : request.patterns.filter((pattern) => typeof pattern === "string").join("\n")

  if (ROOT_DESTRUCTION.some((pattern) => pattern.test(command))) {
    return "Emergency brake: command contains unmistakable broad system destruction."
  }
  if (OBVIOUS_SECRET_EXPORT.some((pattern) => pattern.test(command))) {
    return "Emergency brake: command appears to export credential material through a network utility."
  }
}
