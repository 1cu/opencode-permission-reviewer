import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { server } from "../src/index.ts"
import { extractPermissionRequest, type RuntimeContext } from "../src/runtime.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"

function replyBody(value: unknown): Record<string, unknown> {
  return ((value as Record<string, unknown>).body ?? {}) as Record<string, unknown>
}

const execFileAsync = promisify(execFile)

// /tmp/opencode is one of the plugin's approved enrichment roots. It exists on
// machines that run OpenCode, but not on a fresh CI runner or a clean clone.
beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
})

describe("runtime decisions", () => {
  test("approves once, disables every reviewer tool, and annotates the tool result", async () => {
    const harness = runtime()
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(replyBody(harness.client.replies[0]).reply).toBe("once")
    expect(harness.client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "approved"])

    const prompt = harness.client.prompts[0] as { body: { model: unknown; variant: string; tools: Record<string, boolean> } }
    expect(prompt.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
    expect(prompt.body.variant).toBe("max")
    expect(Object.values(prompt.body.tools).every((enabled) => enabled === false)).toBe(true)

    const output: { output: string; metadata: unknown } = { output: "safe", metadata: { existing: true } }
    harness.runtime.annotateToolResult("call_1", output)
    expect(output.output).toContain("Automatic permission review approved")
    expect(output.output).toContain("safe")
    expect(output.metadata).toMatchObject({ existing: true })
    expect(output.metadata).toHaveProperty("approvalReviewer")
  })

  test("denies with feedback that the primary agent receives", async () => {
    const client = new MockClient()
    client.nextStructured = decision("deny", { rationale: "This would upload private credentials." })
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(replyBody(client.replies[0])).toEqual({
      reply: "reject",
      message: "[Automatic permission review] This would upload private credentials.",
    })
    expect(client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "denied"])
  })

  test("persists a sanitized decision audit with SSH summaries", async () => {
    const harness = runtime()
    const result = await harness.runtime.process(
      request({
        metadata: { command: "ssh -p 2222 ubuntu@203.0.113.8 'docker ps'" },
        patterns: ["ssh -p 2222 ubuntu@203.0.113.8 'docker ps'"],
      }),
    )
    expect(result.kind).toBe("allow")
    const audits = (harness.ctx as RuntimeContext & { auditRecords: unknown[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      requestID: "per_1",
      outcome: "allow",
      riskLevel: "low",
      ssh: [{ destination: "ubuntu@203.0.113.8", port: "2222" }],
    })
    expect(JSON.stringify(audits[0])).not.toContain("docker ps")
  })

  test("gives Luna older explicit user intent after many operational messages", async () => {
    const client = new MockClient()
    client.messageData = [
      {
        info: { id: "user_migration", role: "user", time: { created: 100 } },
        parts: [{ type: "text", text: "Refactor the config module and remove the legacy parser." }],
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        info: { id: `assistant_${index}`, role: "assistant" },
        parts: [{ type: "text", text: `intermediate operation ${index}` }],
      })),
      {
        info: { id: "compact", role: "user", time: { created: 200 } },
        parts: [{ type: "text", text: "Magic Compact: Compaction in progress..." }],
      },
      {
        info: { id: "assistant_action", role: "assistant" },
        parts: [{ type: "tool", tool: "bash", callID: "call_1", state: { input: { command: "python" } } }],
      },
    ]
    client.promptImpl = async (options) => {
      const prompt = (
        options as { body: { parts: Array<{ type: string; text: string }> } }
      ).body.parts[0]?.text
      expect(prompt).toContain("USER_INTENT_HISTORY")
      expect(prompt).toContain("Refactor the config module")
      expect(prompt).not.toContain("Magic Compact")
      return { data: { info: { structured: decision("allow") } } }
    }
    const harness = runtime(client)
    expect((await harness.runtime.process(request({ metadata: { command: "python" } }))).kind).toBe("allow")
    expect(client.messageQueries[0]).toMatchObject({ query: { limit: 200 } })
  })

  test("rejects missing remote stdin automatically without invoking Luna", async () => {
    const client = new MockClient()
    const missing = `/tmp/opencode/approval-reviewer-missing-${crypto.randomUUID()}.py`
    const command = `cat ${missing} | ssh ubuntu@203.0.113.8 'docker exec -i app python -'`
    const harness = runtime(client)
    const result = await harness.runtime.process(
      request({ patterns: [command], metadata: { command } }),
    )
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("does not exist after a second check")
    expect(client.creates).toHaveLength(0)
    expect(client.prompts).toHaveLength(0)
    expect(replyBody(client.replies[0]).reply).toBe("reject")
    expect(client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "denied"])
  })

  test("leaves sensitive but existing remote stdin decisions to Luna", async () => {
    const directory = await mkdtemp("/tmp/opencode/approval-reviewer-sensitive-")
    const script = `${directory}/script.py`
    // Synthetic credential assembled by concatenation so no continuous
    // secret-shaped literal appears in source (see AGENTS.md).
    const synthCred = "sk-" + "syntheticcredential123456789"
    await writeFile(script, `api_key = "${synthCred}"\n`)
    try {
      const client = new MockClient()
      client.nextStructured = decision("deny", { rationale: "Luna rejected the credential-bearing script." })
      const command = `cat ${script} | ssh ubuntu@203.0.113.8 'python -'`
      const result = await runtime(client).runtime.process(
        request({ patterns: [command], metadata: { command } }),
      )
      expect(result.kind).toBe("deny")
      expect(client.creates).toHaveLength(1)
      expect(client.prompts).toHaveLength(1)
      expect(result.reason).toContain("Luna rejected")
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test("includes bounded local script semantics in Luna's prompt without deciding locally", async () => {
    const directory = await mkdtemp("/tmp/opencode/approval-reviewer-runtime-script-")
    const script = join(directory, "consolidate.py")
    await writeFile(script, 'from pathlib import Path\nPath("guide.md").write_text("updated")\n')
    try {
      const client = new MockClient()
      client.nextStructured = decision("allow", { rationale: "The requested local edit is bounded." })
      const command = `source /opt/conda.sh && conda activate app && python3 ${script}`
      const harness = runtime(client, {}, undefined, { directory, worktree: directory })
      expect(
        (await harness.runtime.process(request({ patterns: [command], metadata: { command } }))).kind,
      ).toBe("allow")
      const prompt = JSON.stringify(client.prompts[0])
      expect(prompt).toContain("LOCAL_SCRIPT_ANALYSIS")
      expect(prompt).toContain("guide.md")
      expect(prompt).toContain("fileMutationHint")
      expect(client.creates).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test("includes branch and preexisting staging in Luna's prompt for compound Git commits", async () => {
    const directory = await mkdtemp("/tmp/opencode/approval-reviewer-runtime-git-")
    try {
      await execFileAsync("git", ["init", "-b", "staging"], { cwd: directory })
      await execFileAsync("git", ["config", "user.email", "reviewer@example.invalid"], { cwd: directory })
      await execFileAsync("git", ["config", "user.name", "Reviewer Test"], { cwd: directory })
      await writeFile(join(directory, "target.py"), "before = 1\n")
      await writeFile(join(directory, "unrelated.py"), "before = 1\n")
      await execFileAsync("git", ["add", "target.py", "unrelated.py"], { cwd: directory })
      await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: directory })
      await writeFile(join(directory, "target.py"), "before = 2\n")
      await writeFile(join(directory, "unrelated.py"), "before = 3\n")
      await execFileAsync("git", ["add", "unrelated.py"], { cwd: directory })

      const client = new MockClient()
      client.nextStructured = decision("deny", { rationale: "An unrelated file is already staged." })
      const command = 'git add target.py && git commit -m "target only"'
      const harness = runtime(client, {}, undefined, { directory, worktree: directory })
      expect(
        (await harness.runtime.process(request({ patterns: [command], metadata: { command } }))).kind,
      ).toBe("deny")
      const prompt = JSON.stringify(client.prompts[0])
      expect(prompt).toContain("GIT_STATE_ANALYSIS")
      expect(prompt).toContain('\\"branch\\": \\"staging\\"')
      expect(prompt).toContain("target.py")
      expect(prompt).toContain("unrelated.py")
      expect(client.creates).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test.each([
    ["invalid output", { invalid: true }],
    ["low confidence", decision("allow", { confidence: 0.2 })],
    ["critical model allow", decision("allow", { risk_level: "critical" })],
  ])("leaves the original request pending for %s", async (_name, structured) => {
    const client = new MockClient()
    client.nextStructured = structured
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "manual"])
  })

  test("fails safe to a human when transcript retrieval fails", async () => {
    const client = new MockClient()
    client.messagesError = { message: "database unavailable" }
    const errors: unknown[] = []
    const harness = runtime(client, {}, (_message, details) => errors.push(details))
    harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(client.replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "manual"])
  })

  test("times out without approving or rejecting", async () => {
    const client = new MockClient()
    client.promptImpl = () => new Promise(() => {})
    const result = await runtime(client, { timeoutMs: 10 }).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("timed out")
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "manual"])
  })

  test("rejects reviewer recursion before another model call", async () => {
    const client = new MockClient()
    let nestedKind: string | undefined
    let harness: ReturnType<typeof runtime>
    client.promptImpl = async (options) => {
      const reviewSessionID = (options as { path: { id: string } }).path.id
      nestedKind = (
        await harness.runtime.process(
          request({ id: "per_recursive", sessionID: reviewSessionID, tool: { messageID: "m2", callID: "c2" } }),
        )
      ).kind
      return { data: { info: { structured: decision("allow") } } }
    }
    harness = runtime(client)
    expect((await harness.runtime.process(request())).kind).toBe("allow")
    expect(nestedKind).toBe("deny")
    expect(client.creates).toHaveLength(1)
    expect(client.replies.map(replyBody).map((body) => body.reply).sort()).toEqual(["once", "reject"])
  })

  test("deterministic critical brake rejects without invoking a model", async () => {
    const harness = runtime()
    const result = await harness.runtime.process(request({ metadata: { command: "rm -rf /" } }))
    expect(result.kind).toBe("deny")
    expect(harness.client.creates).toHaveLength(0)
    expect(replyBody(harness.client.replies[0]).reply).toBe("reject")
    expect(harness.client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "denied"])
  })

  test("deduplicates repeated permission events", async () => {
    const harness = runtime()
    for (let index = 0; index < 100; index += 1) harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(harness.client.creates).toHaveLength(1)
    expect(harness.client.replies).toHaveLength(1)
  })

  test("stores approval rationale before replying to avoid a fast-tool race", async () => {
    const client = new MockClient()
    let runtimeRef: ReturnType<typeof runtime>["runtime"]
    const racedOutput = { output: "instant result", metadata: {} }
    client.permissionReply = async (options: unknown) => {
      client.replies.push(options)
      runtimeRef.annotateToolResult("call_1", racedOutput)
      return { data: true }
    }
    const harness = runtime(client)
    runtimeRef = harness.runtime
    expect((await harness.runtime.process(request())).kind).toBe("allow")
    expect(racedOutput.output).toContain("Automatic permission review approved")
    expect(racedOutput.output).toContain("instant result")
  })

  test("clears stale approval annotations if the session is rejected", async () => {
    const harness = runtime()
    await harness.runtime.process(request())
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "another", reply: "reject" },
    })
    const output = { output: "tool should not normally complete", metadata: {} }
    harness.runtime.annotateToolResult("call_1", output)
    expect(output.output).toBe("tool should not normally complete")
  })

  test("turns an approved review back into manual if OpenCode cannot accept the reply", async () => {
    const client = new MockClient()
    client.replyError = { message: "request still pending" }
    const harness = runtime(client)
    harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(client.uiStatuses.map((status) => status.phase)).toEqual(["reviewing", "approved", "manual"])
  })

  test("a broken TUI status channel never changes the safety decision", async () => {
    const client = new MockClient()
    client.publishUiStatus = async (status) => {
      client.uiStatuses.push(status)
      throw new Error("no TUI attached")
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(replyBody(client.replies[0]).reply).toBe("once")
  })

  test("a manual reject during the model call supersedes the review (no double reply, no annotation)", async () => {
    const client = new MockClient()
    const resolvers: Array<(value: { data: Record<string, unknown> }) => void> = []
    client.promptImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const harness = runtime(client)
    harness.runtime.handle(request())
    // Let the reviewer reach the model call, then have the human reject.
    await new Promise((r) => setTimeout(r, 5))
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "per_1", reply: "reject" },
    })
    for (const resolve of resolvers) resolve({ data: { info: { structured: decision("allow") } } })
    await harness.runtime.waitForIdle()
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing"])
    const output = { output: "should not be annotated", metadata: {} }
    harness.runtime.annotateToolResult("call_1", output)
    expect(output.output).toBe("should not be annotated")
  })

  test("a manual allow during the model call supersedes the review (no duplicate once)", async () => {
    const client = new MockClient()
    const resolvers: Array<(value: { data: Record<string, unknown> }) => void> = []
    client.promptImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const harness = runtime(client)
    harness.runtime.handle(request())
    await new Promise((r) => setTimeout(r, 5))
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "per_1", reply: "once" },
    })
    for (const resolve of resolvers) resolve({ data: { info: { structured: decision("deny") } } })
    await harness.runtime.waitForIdle()
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing"])
  })

  test("a manual reply for one request does not cancel a sibling review in the same session", async () => {
    const client = new MockClient()
    const resolvers: Array<(value: { data: Record<string, unknown> }) => void> = []
    client.promptImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const harness = runtime(client)
    harness.runtime.handle(request({ id: "per_1", tool: { messageID: "m1", callID: "c1" } }))
    harness.runtime.handle(request({ id: "per_2", tool: { messageID: "m2", callID: "c2" } }))
    await new Promise((r) => setTimeout(r, 10))
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "per_2", reply: "reject" },
    })
    for (const resolve of resolvers) resolve({ data: { info: { structured: decision("allow") } } })
    await harness.runtime.waitForIdle()
    // The sibling review that was NOT answered manually completes normally.
    expect(client.replies.filter((r) => replyBody(r).reply === "once")).toHaveLength(1)
    expect(client.replies.filter((r) => replyBody(r).reply === "reject")).toHaveLength(0)
    expect(resolvers).toHaveLength(2)
  })

  test("a reply to an unknown request leaves in-flight reviews untouched (and does not leak)", async () => {
    const harness = runtime()
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "never_seen", reply: "reject" },
    })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(replyBody(harness.client.replies[0]).reply).toBe("once")
  })

  test("a manual reject during the model call also supersedes an escalate outcome (no manual resurrection)", async () => {
    const client = new MockClient()
    const resolvers: Array<(value: { data: Record<string, unknown> }) => void> = []
    client.promptImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const harness = runtime(client)
    harness.runtime.handle(request())
    await new Promise((r) => setTimeout(r, 5))
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "per_1", reply: "reject" },
    })
    // Low-confidence allow becomes an escalate; the manual reply must still win.
    for (const resolve of resolvers) resolve({ data: { info: { structured: decision("allow", { confidence: 0.2 }) } } })
    await harness.runtime.waitForIdle()
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing"])
  })

  test("a 404 on the reply (window residual) is benign: no manual resurrection, annotation rolled back", async () => {
    const client = new MockClient()
    client.replyError = { status: 404, message: "PermissionNotFoundError" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(client.uiStatuses.map((s) => s.phase)).not.toContain("manual")
    const output = { output: "x", metadata: {} }
    harness.runtime.annotateToolResult("call_1", output)
    expect(output.output).toBe("x")
  })

  test("a PermissionNotFoundError message without status/code is still recognized as already-resolved", async () => {
    const client = new MockClient()
    client.replyError = { message: "PermissionNotFoundError: request not found" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(client.uiStatuses.map((s) => s.phase)).not.toContain("manual")
  })
})

describe("event boundary", () => {
  test("only accepts permission.asked with a complete request shape", () => {
    expect(extractPermissionRequest({ type: "permission.replied", properties: request() })).toBeUndefined()
    expect(extractPermissionRequest({ type: "permission.asked", properties: { id: "x" } })).toBeUndefined()
    expect(extractPermissionRequest({ type: "permission.asked", properties: request() })).toEqual(request())
  })

  test("plugin uses OpenCode V1's authenticated raw transport to reply", async () => {
    const client = new MockClient()
    const rawPosts: unknown[] = []
    const input = {
      client: {
        session: client.session,
        tool: client.tool,
        _client: {
          post: async (options: unknown) => {
            rawPosts.push(options)
            return { data: true }
          },
        },
      },
      directory: "/workspace/project",
      worktree: "/workspace/project",
    }
    const hooks = await server(input as never, { retainReviewSessions: false, audit: false })
    await hooks.event?.({ event: { type: "permission.asked", properties: request() } as never })
    await hooks.dispose?.()
    expect(rawPosts.filter((post) => (post as { url?: string }).url === "/tui/publish")).toHaveLength(2)
    const reply = rawPosts.find((post) => (post as { url?: string }).url === "/permission/{requestID}/reply")
    expect(reply).toMatchObject({
      url: "/permission/{requestID}/reply",
      path: { requestID: "per_1" },
      body: { reply: "once" },
    })
    expect(client.deletes).toHaveLength(1)
  })
})
