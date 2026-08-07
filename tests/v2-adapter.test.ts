import { describe, expect, test } from "bun:test"
import { assertV1Host } from "../src/opencode/v2-adapter.ts"

describe("v2 host gate", () => {
  test("accepts a v1 client with the raw transport", () => {
    expect(() => assertV1Host({ _client: { post: () => Promise.resolve({}) } })).not.toThrow()
    expect(() => assertV1Host({})).not.toThrow()
  })

  test("refuses a v2-generation client clearly", () => {
    // permission.reply present, no _client.post — the v2-generation signature.
    expect(() => assertV1Host({ permission: { reply: () => Promise.resolve({}) } })).toThrow(
      /does not support OpenCode v2 hosts yet/,
    )
  })
})
