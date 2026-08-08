import type {
  ActionPurpose,
  EvidenceConfidence,
  IntentBlock,
  IntentContext,
  MessageWithParts,
  PermissionRequest,
} from "../types.ts"

const PURPOSE_METADATA_KEYS = ["purpose", "description", "goal", "intent"] as const
const MAX_PURPOSE_CHARS = 500

/**
 * Resolve the operational purpose of a pending action.
 *
 * Order (never invent):
 * 1. Explicit purpose fields on the permission/tool metadata (`agent-context`).
 * 2. Text from the exact assistant message that contains this tool call
 *    (`agent-context`), located via `request.tool.messageID` / `callID`.
 * 3. Local session intent, then a single unambiguous delegated task
 *    (`intent-derived`). Multiple parent delegated tasks are ignored — they
 *    may belong to sibling subagents and must not be attributed here.
 * 4. `unavailable` when no usable evidence exists.
 *
 * Purpose explains what the agent appears to be trying to do. It is untrusted
 * evidence and never demonstrates user authorization by itself.
 */
export function resolveActionPurpose(
  request: PermissionRequest,
  intent: IntentContext | undefined,
  messages: MessageWithParts[] = [],
): ActionPurpose {
  const fromMetadata = purposeFromMetadata(request.metadata)
  if (fromMetadata !== undefined) {
    return {
      text: fromMetadata,
      source: "agent-context",
      confidence: "medium",
    }
  }

  const fromToolMessage = purposeFromToolMessage(request, messages)
  if (fromToolMessage !== undefined) {
    return {
      text: fromToolMessage,
      source: "agent-context",
      confidence: "medium",
    }
  }

  const fromIntent = purposeFromIntent(intent)
  if (fromIntent !== undefined) {
    return {
      text: fromIntent.text,
      source: "intent-derived",
      confidence: fromIntent.confidence,
    }
  }

  return { source: "unavailable", confidence: "unknown" }
}

function purposeFromMetadata(metadata: Record<string, unknown>): string | undefined {
  for (const key of PURPOSE_METADATA_KEYS) {
    const value = metadata[key]
    if (typeof value === "string") {
      const text = boundPurpose(value)
      if (text !== undefined) return text
    }
  }
  return undefined
}

/**
 * Locate the assistant message that issued this tool call and recover any
 * natural-language text parts that accompany it. Those parts are the agent's
 * immediate stated reason for the action — still untrusted, never authorization.
 */
function purposeFromToolMessage(
  request: PermissionRequest,
  messages: MessageWithParts[],
): string | undefined {
  const tool = request.tool
  if (!tool?.messageID || messages.length === 0) return undefined

  const container = messages.find((message) => message.info.id === tool.messageID)
  if (!container) return undefined
  // Only assistant prose is agent-context purpose. User text belongs in intent
  // channels and must not be relabeled here.
  if (container.info.role !== "assistant") return undefined

  // Prefer confirming the specific callID when present; if the part list has no
  // matching tool part, still allow text recovery from the same messageID —
  // some hosts omit callID linkage while keeping message identity.
  if (typeof tool.callID === "string" && tool.callID.length > 0) {
    const hasCall = (container.parts as Array<Record<string, unknown>>).some(
      (part) => part.type === "tool" && part.callID === tool.callID,
    )
    if (!hasCall) {
      // Message exists but does not contain this call — do not attribute its
      // prose to a different tool invocation.
      const anyTool = (container.parts as Array<Record<string, unknown>>).some(
        (part) => part.type === "tool",
      )
      if (anyTool) return undefined
    }
  }

  const texts: string[] = []
  for (const part of container.parts as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string") {
      const text = boundPurpose(part.text)
      if (text !== undefined) texts.push(text)
    }
  }
  if (texts.length === 0) return undefined
  return boundPurpose(texts.join(" "))
}

function purposeFromIntent(
  intent: IntentContext | undefined,
): { text: string; confidence: EvidenceConfidence } | undefined {
  if (intent === undefined) return undefined

  // Prefer intent recovered in the current session — it cannot be a sibling's
  // delegated brief from the parent transcript.
  const local = latestBlockText(intent.localSessionIntent)
  if (local !== undefined) {
    return { text: local, confidence: "medium" }
  }

  // Parent delegated tasks are only safe when exactly one is present. With
  // multiple siblings the parent transcript lists several briefs and the
  // latest one may belong to a different child session.
  if (intent.delegatedTask.length === 1) {
    const text = boundPurpose(intent.delegatedTask[0]!.text)
    if (text !== undefined) {
      return { text, confidence: "medium" }
    }
  }

  return undefined
}

function latestBlockText(blocks: IntentBlock[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const text = boundPurpose(blocks[index]!.text)
    if (text !== undefined) return text
  }
  return undefined
}

function boundPurpose(value: string): string | undefined {
  const compact = value.replace(/\s+/g, " ").trim()
  if (compact.length < 3) return undefined
  if (compact.length <= MAX_PURPOSE_CHARS) return compact
  return `${compact.slice(0, MAX_PURPOSE_CHARS - 1)}…`
}
