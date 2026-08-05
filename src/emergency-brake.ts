import type { PermissionRequest } from "./types.ts"
import { effectiveCommands, lexSegments, type ShellToken, shellBasename } from "./shell-lexer.ts"

/*
 * Deterministic emergency brake.
 *
 * Inspects a pending bash command for *unmistakable* broad destruction or
 * obvious credential export and rejects it before any model call. Everything
 * ambiguous is left to the reviewer.
 *
 * Root destruction is detected with a quote-aware, wrapper-aware shell lexer
 * (see shell-lexer.ts) so that privilege prefixes (`sudo`, `doas`, `env`,
 * `command`, …), absolute binary paths (`/bin/rm`, `/usr/bin/rm`), combined or
 * separated flags (`-rf`, `-r -f`, `--recursive --force`), end-of-options
 * (`--`), and command-string forms (`sh -c '…'`, `su -c …`, `ssh host …`,
 * `busybox rm …`, `chroot root …`) are peeled before judging the executable.
 *
 * It deliberately does NOT expand variables, globs, command substitutions, or
 * heredocs. Those remain the reviewer's job; the brake only catches literal,
 * unambiguous `rm -rf /`-style root destruction (target resolves to `/`).
 */

const ROOT_DESTRUCTION_REGEX = [
  // Block-device formatting / raw overwrite (already robust to `sudo` via `\b`).
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//i,
  /\bdd\b[^\n;&|]*\bof=\/dev\/(?:sd|nvme|vd|xvd)/i,
  // Fork bomb.
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
]

const OBVIOUS_SECRET_EXPORT = [
  /\b(?:curl|wget|nc|ncat|socat)\b[^\n]*(?:\.ssh\/(?:id_|authorized_keys)|\.aws\/credentials|\.config\/gh\/hosts\.yml)/i,
  /\b(?:curl|wget|nc|ncat|socat)\b[^\n]*(?:api[_-]?key|access[_-]?token|private[_-]?key|session[_-]?cookie)/i,
]

const ROOT_DESTRUCTION_REASON =
  "Emergency brake: command contains unmistakable broad system destruction."
const SECRET_EXPORT_REASON =
  "Emergency brake: command appears to export credential material through a network utility."

/** Short flags that make `rm` recursive / forceful when clustered (e.g. `-rf`). */
function hasRmFlags(tokens: ShellToken[]): { recursive: boolean; force: boolean } {
  let recursive = false
  let force = false
  let endOfFlags = false
  for (let i = 1; i < tokens.length; i += 1) {
    const value = tokens[i]!.value
    if (!endOfFlags && value === "--") {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && value.startsWith("-") && value.length > 1) {
      if (value === "--recursive" || value === "-R") recursive = true
      else if (value === "--force") force = true
      else if (value.startsWith("--")) {
        // Other long flags (--no-preserve-root, --one-file-system, …): no effect on r/f.
        continue
      } else {
        // Clustered short flags; GNU rm allows them interleaved with operands.
        if (value.includes("r") || value.includes("R")) recursive = true
        if (value.includes("f")) force = true
      }
      continue
    }
  }
  return { recursive, force }
}

/**
 * A literal target resolves to the filesystem root `/` after dropping trailing
 * `.`, `..`, and empty components. We do NOT touch variables, globs, command
 * substitutions, or backslash escapes (the lexer already produced the shell
 * value): those stay non-literal and out of the brake's remit, so `rm -rf '\/'`
 * is left untouched (it is a file literally named `\`-slash, not root).
 */
function resolvesToRoot(rawTarget: string): boolean {
  if (!rawTarget.startsWith("/")) return false
  const stack: string[] = []
  for (const part of rawTarget.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0
}

function isRmRootDestruction(command: string): boolean {
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) {
      if (effective.length === 0) continue
      if (shellBasename(effective[0]!.value) !== "rm") continue
      const { recursive, force } = hasRmFlags(effective)
      if (!recursive || !force) continue
      let endOfFlags = false
      for (let i = 1; i < effective.length; i += 1) {
        const value = effective[i]!.value
        if (!endOfFlags && value === "--") {
          endOfFlags = true
          continue
        }
        if (!endOfFlags && value.startsWith("-") && value.length > 1) continue
        if (resolvesToRoot(value)) return true
      }
    }
  }
  return false
}

export function emergencyBrakeReason(request: PermissionRequest): string | undefined {
  if (request.permission !== "bash") return
  const command =
    typeof request.metadata.command === "string"
      ? request.metadata.command
      : request.patterns.filter((pattern) => typeof pattern === "string").join("\n")

  if (isRmRootDestruction(command)) return ROOT_DESTRUCTION_REASON
  if (ROOT_DESTRUCTION_REGEX.some((pattern) => pattern.test(command))) return ROOT_DESTRUCTION_REASON
  if (OBVIOUS_SECRET_EXPORT.some((pattern) => pattern.test(command))) return SECRET_EXPORT_REASON
}
