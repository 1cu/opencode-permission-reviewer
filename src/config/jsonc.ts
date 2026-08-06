/** Minimal JSONC (JSON with comments) parser with zero dependencies.
 *
 * Strips line comments, block comments, and trailing commas, then delegates to
 * `JSON.parse`. String contents are preserved verbatim (comment markers inside
 * strings are NOT stripped). Handles escape sequences.
 *
 * Used by the config loader to read `~/.config/opencode/permission-reviewer.jsonc`
 * and `.opencode/permission-reviewer.jsonc`. Returns `{}` on parse failure so
 * a malformed config file degrades to defaults rather than crashing the plugin.
 */
export function parseJsonc(text: string): Record<string, unknown> {
  const stripped = stripCommentsAndTrailingCommas(text)
  try {
    const parsed: unknown = JSON.parse(stripped)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** Strip JSONC comments and trailing commas while preserving string contents. */
function stripCommentsAndTrailingCommas(input: string): string {
  let out = ""
  let i = 0
  const len = input.length
  while (i < len) {
    const ch = input[i]!
    const next = input[i + 1]

    // String literal — copy verbatim until the closing quote.
    if (ch === '"') {
      out += ch
      i += 1
      while (i < len) {
        const c = input[i]!
        out += c
        if (c === "\\" && i + 1 < len) {
          out += input[i + 1]!
          i += 2
          continue
        }
        i += 1
        if (c === '"') break
      }
      continue
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      i += 2
      while (i < len && input[i] !== "\n") i += 1
      continue
    }

    // Block comment.
    if (ch === "/" && next === "*") {
      i += 2
      while (i < len && !(input[i] === "*" && input[i + 1] === "/")) i += 1
      i += 2
      continue
    }

    out += ch
    i += 1
  }

  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1")
}
