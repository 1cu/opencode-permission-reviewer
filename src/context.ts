import type { MessageWithParts, PermissionRequest, ReviewEnvelope, ReviewerConfig } from "./types.ts"

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const omitted = value.length - max
  return `${value.slice(0, max)}\n<truncated characters="${omitted}" />`
}

function stableJson(value: unknown, max: number): string {
  try {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return item.toString()
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]"
          seen.add(item)
        }
        return item
      },
      2,
    )
    return truncate(text ?? String(value), max)
  } catch {
    return truncate(String(value), max)
  }
}

function partSummary(part: Record<string, unknown>, maxPartChars: number): string | undefined {
  const type = typeof part.type === "string" ? part.type : "unknown"
  if (type === "text" || type === "reasoning") {
    const text = typeof part.text === "string" ? part.text : ""
    if (!text.trim()) return
    return `${type}: ${truncate(text, maxPartChars)}`
  }
  if (type === "tool") {
    const compact = {
      type,
      tool: part.tool,
      callID: part.callID,
      state: part.state,
    }
    return `tool: ${stableJson(compact, maxPartChars)}`
  }
  if (type === "file") {
    return `file: ${stableJson({ mime: part.mime, filename: part.filename, url: part.url }, 1_000)}`
  }
  if (type === "step-start" || type === "step-finish" || type === "snapshot") return
  return `${type}: ${stableJson(part, Math.min(maxPartChars, 2_000))}`
}

function messageSummary(message: MessageWithParts, maxPartChars: number): string | undefined {
  const role = typeof message.info.role === "string" ? message.info.role : "unknown"
  const id = typeof message.info.id === "string" ? message.info.id : "unknown"
  const parts = message.parts
    .map((part) => {
      if (
        role === "user" &&
        part.type === "text" &&
        typeof part.text === "string" &&
        isSyntheticControlMessage(part.text)
      ) {
        return
      }
      return partSummary(part, maxPartChars)
    })
    .filter((part): part is string => Boolean(part))
  if (parts.length === 0) return
  return `MESSAGE role=${role} id=${id}\n${parts.join("\n")}`
}

export function buildTranscript(messages: MessageWithParts[], config: ReviewerConfig): string {
  const selected = messages.slice(-config.transcriptMessages)
  const summaries = selected
    .map((message) => messageSummary(message, config.maxPartChars))
    .filter((summary): summary is string => Boolean(summary))
  return truncate(summaries.join("\n\n"), config.maxContextChars)
}

function isSyntheticControlMessage(text: string): boolean {
  const normalized = text.trim()
  return (
    /^Magic Compact:\s*Compaction in progress/i.test(normalized) ||
    /^You have \d+ weighted tokens left/i.test(normalized)
  )
}

function userIntentSummary(message: MessageWithParts, config: ReviewerConfig): string | undefined {
  if (message.info.role !== "user") return
  const texts = message.parts.flatMap((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return []
    const text = part.text.trim()
    if (!text || isSyntheticControlMessage(text)) return []
    return [truncate(text, config.maxPartChars)]
  })
  if (texts.length === 0) return
  const id = typeof message.info.id === "string" ? message.info.id : "unknown"
  const time =
    typeof message.info.time === "object" &&
    message.info.time !== null &&
    typeof (message.info.time as Record<string, unknown>).created === "number"
      ? ` created=${(message.info.time as Record<string, unknown>).created}`
      : ""
  return `USER_INTENT id=${id}${time}\n${texts.join("\n")}`
}

function keepMostRecentBlocks(blocks: string[], maxChars: number): string {
  const selected: string[] = []
  let remaining = maxChars
  for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const block = blocks[index]!
    const separator = selected.length === 0 ? 0 : 2
    if (remaining <= separator) break
    const bounded = truncate(block, remaining - separator)
    selected.push(bounded)
    remaining -= bounded.length + separator
  }
  return selected.reverse().join("\n\n")
}

export function buildIntentHistory(messages: MessageWithParts[], config: ReviewerConfig): string {
  const seen = new Set<string>()
  const summaries = messages.flatMap((message) => {
    const summary = userIntentSummary(message, config)
    if (!summary) return []
    const fingerprint = summary.replace(/^USER_INTENT[^\n]*\n/, "")
    if (seen.has(fingerprint)) return []
    seen.add(fingerprint)
    return [summary]
  })
  return keepMostRecentBlocks(summaries.slice(-config.intentMessages), config.maxIntentChars)
}

export function buildEvidence(envelope: ReviewEnvelope, config: ReviewerConfig): string {
  const request: PermissionRequest = envelope.request
  const evidence = [
    `WORKING_DIRECTORY\n${envelope.directory}`,
    `WORKTREE\n${envelope.worktree}`,
    `PENDING_PERMISSION\n${stableJson(
      {
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        tool: request.tool,
      },
      config.maxPartChars * 2,
    )}`,
    envelope.enrichment || "ACTION_ENRICHMENT\n<none />",
    `USER_INTENT_HISTORY\n${envelope.intentHistory || "<no user intent history available />"}`,
    `RECENT_TRANSCRIPT\n${envelope.transcript || "<no transcript available />"}`,
  ].join("\n\n")
  return truncate(
    evidence,
    config.maxContextChars + config.maxPartChars * 2 + config.maxEnrichmentChars + config.maxIntentChars,
  )
}

export function normalizeMessages(value: unknown): MessageWithParts[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const record = item as Record<string, unknown>
    const info = typeof record.info === "object" && record.info !== null ? record.info : {}
    const parts = Array.isArray(record.parts)
      ? record.parts.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
      : []
    return [{ info: info as MessageWithParts["info"], parts }]
  })
}
