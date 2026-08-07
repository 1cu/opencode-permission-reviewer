import { appendFile, mkdir } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { ReviewAuditRecord, ReviewerConfig } from "./types.ts"

export const DEFAULT_AUDIT_PATH = "~/.local/share/opencode/permission-reviewer-audit.jsonl"

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

/** Resolve the audit path the way the writer does. */
export function resolveAuditPath(config: ReviewerConfig): string {
  return expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
}

/** The required identity/decision fields every audit record must carry. Used
 *  by the report reader to flag truncated or malformed lines. */
const REQUIRED_AUDIT_FIELDS = [
  "timestamp",
  "requestID",
  "sessionID",
  "permission",
  "outcome",
  "reason",
] as const

export interface AuditMissingFields {
  lineNo: number
  missing: string[]
}

export interface AuditSummary {
  path: string
  exists: boolean
  totalLines: number
  validRecords: number
  invalidLines: number
  bySchemaVersion: Record<string, number>
  byOutcome: Record<string, number>
  byRiskLevel: Record<string, number>
  byDecisionSource: Record<string, number>
  byPermission: Record<string, number>
  unknownActorNames: Array<{ name: string; count: number }>
  missingRequiredFields: AuditMissingFields[]
  firstTimestamp?: string
  lastTimestamp?: string
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Read an append-only JSONL audit file and summarize it. Never throws: a
 *  missing/unreadable file returns an empty summary with `exists: false`. */
export function readAuditSummary(path: string): AuditSummary {
  const summary: AuditSummary = {
    path,
    exists: false,
    totalLines: 0,
    validRecords: 0,
    invalidLines: 0,
    bySchemaVersion: {},
    byOutcome: {},
    byRiskLevel: {},
    byDecisionSource: {},
    byPermission: {},
    unknownActorNames: [],
    missingRequiredFields: [],
  }
  let text: string
  try {
    text = readFileSync(path, "utf8")
    summary.exists = true
  } catch {
    return summary
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  summary.totalLines = lines.length
  const actorCounts = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let record: Record<string, unknown>
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>
    } catch {
      summary.invalidLines++
      continue
    }
    summary.validRecords++
    bump(summary.bySchemaVersion, String(record.schemaVersion ?? 1))
    if (typeof record.outcome === "string") bump(summary.byOutcome, record.outcome)
    bump(summary.byRiskLevel, typeof record.riskLevel === "string" ? record.riskLevel : "(none)")
    if (typeof record.decisionSource === "string")
      bump(summary.byDecisionSource, record.decisionSource)
    if (typeof record.permission === "string") bump(summary.byPermission, record.permission)
    if (typeof record.timestamp === "string") {
      if (summary.firstTimestamp === undefined || record.timestamp < summary.firstTimestamp) {
        summary.firstTimestamp = record.timestamp
      }
      if (summary.lastTimestamp === undefined || record.timestamp > summary.lastTimestamp) {
        summary.lastTimestamp = record.timestamp
      }
    }
    const missing = REQUIRED_AUDIT_FIELDS.filter((f) => record[f] === undefined)
    if (missing.length > 0) summary.missingRequiredFields.push({ lineNo, missing })
    const actor = record.actor as { name?: string; profile?: string } | undefined
    const isUnknown =
      actor === undefined ||
      actor.profile === "unknown" ||
      actor.name === undefined ||
      actor.name === ""
    if (isUnknown) {
      const name = actor?.name ?? (actor === undefined ? "(no actor field)" : "(unnamed)")
      actorCounts.set(name, (actorCounts.get(name) ?? 0) + 1)
    }
  }
  summary.unknownActorNames = [...actorCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return summary
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[\r\n]+/g, " ").trim()
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`
}

export function createAuditWriter(
  config: ReviewerConfig,
  logger?: (message: string, details?: unknown) => void,
): ((record: ReviewAuditRecord) => Promise<void>) | undefined {
  if (!config.audit) return
  const path = expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
  let ready: Promise<void> | undefined
  return async (record) => {
    ready ??= mkdir(dirname(path), { recursive: true }).then(() => {})
    await ready
    const sanitized: ReviewAuditRecord = {
      ...record,
      reason: boundedReason(record.reason),
    }
    await appendFile(path, `${JSON.stringify(sanitized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }).catch((error) => {
      logger?.("failed to append audit record", {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
