import { describe, expect, test } from "bun:test"
import { extractJsonFromText, parseDecisionFromText } from "../src/decision.ts"
import { decision } from "./helpers.ts"

const valid = decision("allow")

describe("extractJsonFromText", () => {
  test("returns undefined for empty or whitespace-only input", () => {
    expect(extractJsonFromText("")).toBeUndefined()
    expect(extractJsonFromText("   \n  ")).toBeUndefined()
  })

  test("returns undefined when there is no object", () => {
    expect(extractJsonFromText("just prose, no braces")).toBeUndefined()
    expect(extractJsonFromText("[]")).toBeUndefined()
    expect(extractJsonFromText('"a string"')).toBeUndefined()
    expect(extractJsonFromText("null")).toBeUndefined()
  })

  test("parses a bare JSON object", () => {
    expect(extractJsonFromText(JSON.stringify(valid))).toEqual(valid)
  })

  test("parses JSON inside a Markdown code fence", () => {
    const fenced = "```json\n" + JSON.stringify(valid, null, 2) + "\n```"
    expect(extractJsonFromText(fenced)).toEqual(valid)
  })

  test("extracts the object from surrounding prose", () => {
    const prose = "Here is my decision:\n" + JSON.stringify(valid) + "\nThat is all."
    expect(extractJsonFromText(prose)).toEqual(valid)
  })

  test("picks the decision object among multiple objects", () => {
    const text = 'First: {"a":1}\nThen: ' + JSON.stringify(valid)
    expect(extractJsonFromText(text)).toEqual(valid)
  })

  test("ignores braces inside quoted strings", () => {
    const text = 'The note "{ not a real object }" then ' + JSON.stringify(valid)
    expect(extractJsonFromText(text)).toEqual(valid)
  })

  test("returns undefined for truncated/unbalanced JSON", () => {
    const truncated = JSON.stringify(valid).slice(0, JSON.stringify(valid).length - 5)
    expect(extractJsonFromText(truncated)).toBeUndefined()
  })
})

describe("parseDecisionFromText", () => {
  test("parses and validates a valid decision from bare JSON", () => {
    expect(parseDecisionFromText(JSON.stringify(valid))).toEqual(valid)
  })

  test("parses and validates from fenced JSON", () => {
    expect(parseDecisionFromText("```json\n" + JSON.stringify(valid) + "\n```")).toEqual(valid)
  })

  test("returns undefined for valid JSON with a wrong schema version", () => {
    const wrong = { ...valid, version: 1 }
    expect(parseDecisionFromText(JSON.stringify(wrong))).toBeUndefined()
  })

  test("returns undefined for valid JSON with an invalid enum", () => {
    const wrong = { ...valid, outcome: "approve" }
    expect(parseDecisionFromText(JSON.stringify(wrong))).toBeUndefined()
  })

  test("returns undefined for valid JSON with a missing required field", async () => {
    const missing = { ...valid } as Record<string, unknown>
    delete missing.rationale
    expect(parseDecisionFromText(JSON.stringify(missing))).toBeUndefined()
  })

  test("returns undefined for prose with no parseable decision", () => {
    expect(parseDecisionFromText("I cannot decide safely.")).toBeUndefined()
  })
})
