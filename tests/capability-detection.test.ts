import { describe, expect, test } from "bun:test"
import { probeCapabilities } from "../src/opencode/capability-detection.ts"

describe("capability detection", () => {
  test("v1 server client profile", () => {
    // The shape the host hands a server plugin today: a protected _client with
    // post, a session namespace with get, a typed tui.publish, and no
    // permission namespace at all.
    const client = {
      _client: { post: () => Promise.resolve({}) },
      session: { get: () => Promise.resolve({}), messages: () => Promise.resolve({}) },
      tui: { publish: () => Promise.resolve({}) },
    }
    const caps = probeCapabilities(client)
    expect(caps.rawAuthenticatedTransport).toBe(true)
    expect(caps.sessionGet).toBe(true)
    expect(caps.sessionParentID).toBe(true)
    expect(caps.tuiPublish).toBe(true)
    expect(caps.publicPermissionReply).toBe(false)
    expect(caps.permissionReplyMessage).toBe(false)
    expect(caps.assistantAgentMetadata).toBe(false)
    expect(caps.assistantModeMetadata).toBe(false)
    expect(caps.effectivePermissions).toBe(false)
  })

  test("v2-generation client is detected", () => {
    // The v2 client exposes permission.reply and names its transport `client`
    // (no enumerable `_client`).
    const client = {
      permission: { reply: () => Promise.resolve({}) },
      session: { get: () => Promise.resolve({}) },
    }
    const caps = probeCapabilities(client)
    expect(caps.permissionReplyMessage).toBe(true)
    expect(caps.publicPermissionReply).toBe(true)
    expect(caps.rawAuthenticatedTransport).toBe(false)
    expect(caps.assistantAgentMetadata).toBe(true)
    expect(caps.effectivePermissions).toBe(true)
  })

  test("a client with nothing relevant degrades all-false", () => {
    expect(probeCapabilities({})).toEqual({
      publicPermissionReply: false,
      permissionReplyMessage: false,
      rawAuthenticatedTransport: false,
      sessionGet: false,
      sessionParentID: false,
      assistantAgentMetadata: false,
      assistantModeMetadata: false,
      effectivePermissions: false,
      tuiPublish: false,
    })
  })

  test("null/undefined client never throws", () => {
    expect(() => probeCapabilities(null)).not.toThrow()
    expect(() => probeCapabilities(undefined)).not.toThrow()
  })
})
