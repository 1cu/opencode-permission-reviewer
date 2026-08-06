import { createHash } from "node:crypto"
import type { HeredocRecord } from "../types.ts"

/*
 * Heredoc extraction.
 *
 * Runs BEFORE the shell lexer used by the capability analyzer, so heredoc
 * bodies never become tokens the analyzer walks. The motivating case is:
 *
 *   cat > /tmp/x <<'EOF'
 *   ...arbitrary content...
 *   EOF
 *   bun /tmp/x
 *
 * The extractor returns the command with each heredoc body replaced by a
 * redacted placeholder, plus structured records (delimiter, expansion flag,
 * bounded+redacted body, sha256 of the full body, output target when a `> path`
 * precedes the heredoc, dynamic flag).
 *
 * NOTE: this protects the capability analyzer and evidence providers only.
 * The emergency brake operates on the RAW command independently and does NOT
 * use this extractor — heredoc bodies may still appear as tokens the brake
 * sees. This is a known conservative limitation (the brake may false-positive
 * on destructive text inside a heredoc body, but never false-negative).
 *
 * This is a bounded static parser, not a shell executor: it never expands the
 * body, never runs anything, and marks bodies with unresolvable expansions as
 * dynamic (partial analysis).
 */

/** Maximum body bytes retained (bounded + redacted for prompt/audit safety). */
const MAX_BODY_BYTES = 4096

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1(?=\s|$)/

/** Result of extracting heredocs from a raw command. */
export interface HeredocExtraction {
  /** Command with heredoc bodies replaced by placeholder tokens. */
  sanitizedCommand: string
  /** Structured heredoc records. */
  heredocs: HeredocRecord[]
  /** Whether any dynamic construct was detected inside a body. */
  hasDynamicConstructs: boolean
}

/**
 * Extract every heredoc in `command`, replacing each body with a placeholder
 * `<HEREDOC:sha256:xxxxxxxx>` so the downstream lexer never sees the content.
 */
export function extractHeredocs(command: string): HeredocExtraction {
  const heredocs: HeredocRecord[] = []
  let hasDynamicConstructs = false
  let out = ""
  let cursor = 0

  while (cursor <= command.length) {
    const remaining = command.slice(cursor)
    const match = HEREDOC_START.exec(remaining)
    if (match === null) break

    const matchStart = cursor + match.index
    const fullMatch = match[0]
    const operator = fullMatch.startsWith("<<-") ? "<<-" : "<<"
    const delimiter = match[2]!
    const expansionDisabled = match[1] !== undefined && match[1] !== ""

    // Emit the text before the heredoc operator unchanged.
    out += command.slice(cursor, matchStart)

    // Find the line terminator that ends the heredoc-start line.
    let lineEnd = matchStart + match[0].length
    while (lineEnd < command.length && command[lineEnd] !== "\n") lineEnd += 1

    // A pending output redirection on the same line (e.g. `cat > /tmp/x <<'EOF'`).
    const outputTarget = findOutputTarget(command.slice(cursor, matchStart))

    // Collect the body until a line holding only the delimiter (after optional
    // leading tabs for `<<-`).
    const bodyStart = Math.min(lineEnd + 1, command.length)
    const { body, endIndex, truncated } = collectBody(
      command,
      bodyStart,
      delimiter,
      operator === "<<-",
    )

    const fullBody = body
    const sha256 = createHash("sha256").update(fullBody).digest("hex")
    const { bounded, wasTruncated } = boundBody(fullBody, truncated)
    if (containsDynamic(fullBody, expansionDisabled)) hasDynamicConstructs = true

    heredocs.push({
      delimiter,
      operator,
      expansionDisabled,
      bodyBounded: bounded,
      bodySha256: sha256,
      truncated: wasTruncated,
      ...(outputTarget === undefined ? {} : { outputTarget }),
      dynamic: containsDynamic(fullBody, expansionDisabled),
    })

    // Replace the body with a placeholder; keep the line terminator structure so
    // the lexer still splits commands on newlines correctly.
    out += `${operator}${delimiter} <HEREDOC:sha256:${sha256.slice(0, 12)}>`
    cursor = endIndex
  }

  out += command.slice(cursor)
  return { sanitizedCommand: out, heredocs, hasDynamicConstructs }
}

/** Scan the text before a heredoc operator for a trailing `> path` target. */
function findOutputTarget(beforeOperator: string): string | undefined {
  // Match the last `>` / `>>` redirection target on the start line.
  const trimmed = beforeOperator.replace(/\s+$/, "")
  const match = />>?\s*([^\s|;&<>]+)\s*$/.exec(trimmed)
  return match === null ? undefined : stripQuotes(match[1]!)
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const head = token[0]
    const tail = token[token.length - 1]
    if ((head === "'" || head === '"') && head === tail) return token.slice(1, -1)
  }
  return token
}

/** Collect the heredoc body until the delimiter line. Returns the body text and
 *  the index just past the closing delimiter line. */
function collectBody(
  source: string,
  start: number,
  delimiter: string,
  tabStripped: boolean,
): { body: string; endIndex: number; truncated: boolean } {
  let i = start
  let body = ""
  let truncated = false
  while (i < source.length) {
    let lineEnd = source.indexOf("\n", i)
    if (lineEnd === -1) lineEnd = source.length
    const line = source.slice(i, lineEnd)
    const candidate = tabStripped ? line.replace(/^\t+/, "") : line
    if (candidate === delimiter) {
      // Preserve the trailing newline in the stream so the lexer still splits
      // the command that follows the heredoc into its own segment.
      return { body, endIndex: lineEnd, truncated }
    }
    body += line + "\n"
    if (body.length > MAX_BODY_BYTES * 4) truncated = true
    i = lineEnd + 1
  }
  // Unterminated heredoc: treat the remainder as the body (partial).
  truncated = true
  return { body, endIndex: source.length, truncated }
}

function boundBody(
  fullBody: string,
  alreadyTruncated: boolean,
): { bounded: string; wasTruncated: boolean } {
  const bytes = Buffer.byteLength(fullBody, "utf8")
  if (bytes <= MAX_BODY_BYTES) return { bounded: fullBody, wasTruncated: alreadyTruncated }
  // Truncate by character count as a conservative approximation.
  let cut = 0
  let len = 0
  while (cut < fullBody.length && len < MAX_BODY_BYTES) {
    len += Buffer.byteLength(fullBody[cut]!, "utf8")
    cut += 1
  }
  return { bounded: fullBody.slice(0, cut) + "\n…[truncated]", wasTruncated: true }
}

/** Whether the body contains constructs that prevent static analysis. */
function containsDynamic(body: string, expansionDisabled: boolean): boolean {
  if (expansionDisabled) return false
  // With expansion enabled, `$VAR`, `$(...)`, and backticks are unresolvable.
  return /\$\(?|`/.test(body)
}
