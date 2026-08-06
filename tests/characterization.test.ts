import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import type { ReviewAuditRecord } from "../src/types.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"

beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
})

describe("characterization gaps (0.6 prereq)", () => {
  test("session.create transport failure escalates without reviewer call", async () => {
    const client = new MockClient()
    client.createError = { message: "database unavailable" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.create failed")
    expect(client.creates).toHaveLength(1)
    expect(client.prompts).toHaveLength(0)
    expect(client.replies).toHaveLength(0)
    expect(client.deletes).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "manual"])
  })

  test("session.create failure via handle emits manual", async () => {
    const client = new MockClient()
    client.createError = { message: "create failed" }
    const harness = runtime(client)
    harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "manual"])
    expect(client.replies).toHaveLength(0)
  })

  test("tool.ids transport failure escalates and still cleans up the review session", async () => {
    const client = new MockClient()
    client.toolIdsError = { message: "tool discovery failed" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("tool.ids failed")
    expect(client.creates).toHaveLength(1)
    expect(client.prompts).toHaveLength(0)
    expect(client.replies).toHaveLength(0)
    // runReviewer finally deletes the session even when tool.ids failed (reviewSessionID was set)
    expect(client.deletes).toHaveLength(1)
  })

  test("retainReviewSessions true keeps the review session on disk", async () => {
    const client = new MockClient()
    const harness = runtime(client, { retainReviewSessions: true })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.deletes).toHaveLength(0)
    expect(client.creates).toHaveLength(1)
  })

  test("retainReviewSessions false deletes the review session (default)", async () => {
    const client = new MockClient()
    const harness = runtime(client, { retainReviewSessions: false })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.deletes).toHaveLength(1)
  })

  test("publishUiStatus returning {error} does not change the safety decision", async () => {
    const client = new MockClient()
    // Return an error response (not a throw) — emit() must ignore it and still allow.
    client.publishStatusError = { message: "publish failed" }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.replies).toHaveLength(1)
    // Both reviewing + approved phases are still emitted; error response is swallowed.
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "approved"])
  })

  test("publishUiStatus throwing is also fail-safe (existing guarantee, explicit)", async () => {
    const client = new MockClient()
    client.publishUiStatus = async (status) => {
      client.uiStatuses.push(status)
      throw new Error("no TUI attached")
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.replies).toHaveLength(1)
  })

  test("session.prompt transport error escalates", async () => {
    const client = new MockClient()
    client.promptError = { message: "model unavailable" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.prompt failed")
    expect(client.replies).toHaveLength(0)
    expect(client.deletes).toHaveLength(1)
  })

  test("session.prompt missing data escalates (response.data undefined path)", async () => {
    const client = new MockClient()
    // Force session.prompt to return { data: undefined } — responseData will throw "returned no data"
    client.promptImpl = async (options) => {
      client.prompts.push(options)
      return { data: undefined as unknown as Record<string, unknown> }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.prompt")
    expect(client.replies).toHaveLength(0)
  })

  test("session.prompt with no structured field escalates as invalid output", async () => {
    const client = new MockClient()
    client.promptImpl = async (options) => {
      client.prompts.push(options)
      return { data: { info: {} } }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("missing or invalid structured output")
    expect(client.replies).toHaveLength(0)
  })

  test("session.prompt with info missing entirely escalates as invalid output", async () => {
    const client = new MockClient()
    client.promptImpl = async (options) => {
      client.prompts.push(options)
      return { data: {} }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("missing or invalid structured output")
  })

  test("session.create returning non-string id escalates and does not leak session", async () => {
    const client = new MockClient()
    // Override to return a numeric id.
    client.session.create = async (options: unknown) => {
      client.creates.push(options)
      return { data: { id: 123 as unknown as string } }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.create returned an invalid session ID")
    expect(client.deletes).toHaveLength(0)
    expect(client.prompts).toHaveLength(0)
    expect(client.replies).toHaveLength(0)
  })

  test("session.create returning undefined id escalates", async () => {
    const client = new MockClient()
    client.session.create = async (options: unknown) => {
      client.creates.push(options)
      return { data: {} as Record<string, unknown> }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("invalid session ID")
  })

  test("tool.ids failure via direct override still escalates", async () => {
    const client = new MockClient()
    client.tool.ids = async (options?: unknown) => {
      client.toolQueries.push(options)
      return { error: { message: "tool discovery broken" } }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toMatch(/tool\.ids failed/i)
  })

  test("invalid structured output variants escalate (null, string)", async () => {
    for (const bad of [null, "not an object", 123, { outcome: "allow" }]) {
      const client = new MockClient()
      client.nextStructured = bad
      const result = await runtime(client).runtime.process(request())
      expect(result.kind).toBe("escalate")
      expect(client.replies).toHaveLength(0)
    }
  })

  test("low structured output still cleans up review session", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow", { confidence: 0.1 })
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    // Review session is still deleted on escalate path.
    expect(client.deletes).toHaveLength(1)
  })

  test("audit on the error path still carries the ssh summary after collectEnvelope ran", async () => {
    // collectEnvelope runs and populates the ssh bridge; afterwards safeReply
    // throws (non-404 transport failure), so process() rejects and the catch
    // branch writes an audit. That audit must still include the ssh summary —
    // parity we must preserve when the coordinator moves.
    const client = new MockClient()
    client.replyError = { message: "permission transport down" }
    const harness = runtime(client)
    await expect(
      harness.runtime.process(
        request({
          metadata: { command: "ssh -p 2222 ubuntu@203.0.113.8 'docker ps'" },
          patterns: ["ssh -p 2222 ubuntu@203.0.113.8 'docker ps'"],
        }),
      ),
    ).rejects.toThrow("permission.reply failed")
    const audits = (harness.ctx as unknown as { auditRecords: unknown[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      outcome: "escalate",
      schemaVersion: 1,
      ssh: [{ destination: "ubuntu@203.0.113.8", port: "2222" }],
    })
  })

  test("audit records carry schemaVersion 1 on the success path", async () => {
    const harness = runtime()
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.schemaVersion).toBe(1)
  })
})
