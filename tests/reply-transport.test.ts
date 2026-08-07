import { describe, expect, test } from "bun:test"
import { createReplyTransport } from "../src/opencode/reply-transport.ts"
import type { OpenCodeCapabilities, RawTransport } from "../src/opencode/adapter.ts"

const RAW_CAPS: OpenCodeCapabilities = {
  publicPermissionReply: false,
  permissionReplyMessage: false,
  rawAuthenticatedTransport: true,
  sessionGet: true,
  sessionParentID: true,
  assistantAgentMetadata: false,
  assistantModeMetadata: false,
  effectivePermissions: false,
  tuiPublish: true,
}

function recordingTransport(): RawTransport & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    post: (options: unknown) => {
      calls.push(options)
      return Promise.resolve({ data: { ok: true } })
    },
  }
}

describe("reply transport", () => {
  test("routes a reply through the raw transport with the SDK option shape", async () => {
    const raw = recordingTransport()
    const transport = createReplyTransport({ raw, capabilities: RAW_CAPS })
    await transport.reply({ requestID: "per_1", reply: "once", directory: "/repo" })
    expect(raw.calls).toHaveLength(1)
    expect(raw.calls[0]).toEqual({
      url: "/permission/{requestID}/reply",
      path: { requestID: "per_1" },
      body: { reply: "once" },
      query: { directory: "/repo" },
      headers: { "Content-Type": "application/json" },
    })
  })

  test("includes the feedback message only when provided", async () => {
    const raw = recordingTransport()
    const transport = createReplyTransport({ raw, capabilities: RAW_CAPS })
    await transport.reply({
      requestID: "per_2",
      reply: "reject",
      message: "credentials would be exfiltrated",
      directory: "/repo",
    })
    expect((raw.calls[0] as { body: { reply: string; message?: string } }).body).toEqual({
      reply: "reject",
      message: "credentials would be exfiltrated",
    })
  })

  test("refuses startup when no safe reply channel exists", () => {
    expect(() =>
      createReplyTransport({
        raw: undefined,
        capabilities: { ...RAW_CAPS, rawAuthenticatedTransport: false },
      }),
    ).toThrow("authenticated SDK transport is unavailable")
  })

  test("logs the chosen path exactly once at construction", () => {
    const messages: string[] = []
    const raw = recordingTransport()
    createReplyTransport({
      raw,
      capabilities: RAW_CAPS,
      logOnce: (m) => messages.push(m),
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("path=raw-authenticated")
  })
})
