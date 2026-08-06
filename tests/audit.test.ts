import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createAuditWriter, DEFAULT_AUDIT_PATH } from "../src/audit.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { ReviewAuditRecord } from "../src/types.ts"

function record(overrides: Partial<ReviewAuditRecord> = {}): ReviewAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 42,
    requestID: "per_1",
    sessionID: "ses_main",
    permission: "bash",
    outcome: "allow",
    reason: "narrow safe command",
    ...overrides,
  }
}

describe("audit writer", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "approval-reviewer-audit-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("returns undefined when audit is disabled", () => {
    expect(createAuditWriter({ ...DEFAULT_CONFIG, audit: false })).toBeUndefined()
  })

  test("appends one JSONL line per record with mode 0600", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ requestID: "per_a" }))
    await writeAudit(record({ requestID: "per_b" }))
    const content = await readFile(auditPath, "utf8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).requestID).toBe("per_a")
    expect(JSON.parse(lines[1]!).requestID).toBe("per_b")
    const info = await stat(auditPath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test("lazily creates nested directories", async () => {
    const auditPath = join(directory, "nested", "deep", "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record())
    const content = await readFile(auditPath, "utf8")
    expect(content.trim().length).toBeGreaterThan(0)
  })

  test("bounds CRLF/newlines to spaces and truncates to 2000 chars", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    const longReason = `a\r\nb\nc${"x".repeat(3_000)}`
    await writeAudit(record({ reason: longReason }))
    const line = (await readFile(auditPath, "utf8")).trim()
    const parsed = JSON.parse(line) as ReviewAuditRecord
    expect(parsed.reason).not.toContain("\n")
    expect(parsed.reason).not.toContain("\r")
    expect(parsed.reason.length).toBeLessThanOrEqual(2_001) // 2000 + ellipsis
    expect(parsed.reason.endsWith("…")).toBe(true)
  })

  test("short reason is preserved (CRLF -> space normalization)", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ reason: "line1\r\nline2\nline3" }))
    const line = (await readFile(auditPath, "utf8")).trim()
    const parsed = JSON.parse(line) as ReviewAuditRecord
    expect(parsed.reason).toBe("line1 line2 line3")
  })

  test("trims whitespace and preserves exact 2000 char boundary", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    const exactly2000 = "a".repeat(2_000)
    await writeAudit(record({ reason: `  ${exactly2000}  ` }))
    const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim()) as ReviewAuditRecord
    expect(parsed.reason).toBe(exactly2000)
    expect(parsed.reason.length).toBe(2_000)
  })

  test("logger is called on append failure but does not throw", async () => {
    // Use a directory path as auditPath so appendFile fails with EISDIR.
    await mkdir(join(directory, "dir-as-file"))
    const auditPath = join(directory, "dir-as-file")
    const logs: unknown[] = []
    const writeAudit = createAuditWriter(
      { ...DEFAULT_CONFIG, audit: true, auditPath },
      (_msg, details) => logs.push(details),
    )!
    await expect(writeAudit(record())).resolves.toBeUndefined()
    expect(logs.length).toBeGreaterThan(0)
  })

  test("expandHome handles ~ and ~/ paths without throwing", async () => {
    // We cannot write to real ~ in test, but we can verify that `~` and `~/...`
    // are resolved (not treated as relative) — by checking the writer is created
    // and that it does not synchronously throw. We do not actually write to ~.
    const writerTilde = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath: "~" })
    expect(writerTilde).toBeDefined()
    const writerHome = createAuditWriter({
      ...DEFAULT_CONFIG,
      audit: true,
      auditPath: "~/approval-reviewer-test-noop.jsonl",
    })
    expect(writerHome).toBeDefined()
    // Ensure DEFAULT_AUDIT_PATH uses ~ prefix convention.
    expect(DEFAULT_AUDIT_PATH.startsWith("~")).toBe(true)
  })

  test("concurrent writes are serialized via mkdir once", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await Promise.all([
      writeAudit(record({ requestID: "per_1" })),
      writeAudit(record({ requestID: "per_2" })),
      writeAudit(record({ requestID: "per_3" })),
    ])
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(3)
    const ids = lines.map((l) => (JSON.parse(l) as ReviewAuditRecord).requestID).sort()
    expect(ids).toEqual(["per_1", "per_2", "per_3"])
  })

  test("absolute non-tilde path is resolved", async () => {
    const auditPath = join(directory, "explicit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ requestID: "per_x" }))
    const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim()) as ReviewAuditRecord
    expect(parsed.requestID).toBe("per_x")
  })
})
