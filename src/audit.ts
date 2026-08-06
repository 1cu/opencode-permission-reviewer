import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { ReviewAuditRecord, ReviewerConfig } from "./types.ts"

export const DEFAULT_AUDIT_PATH = "~/.local/share/opencode/permission-reviewer-audit.jsonl"

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return resolve(path)
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
