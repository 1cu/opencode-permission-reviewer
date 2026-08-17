import { describe, expect, test } from "bun:test"
import { extractJsonFromText, parseDecisionFromText } from "../src/decision.ts"
import { decision } from "./helpers.ts"

const valid = decision("allow")
const deny = decision("deny")

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

  test("parses a single fence wrapping the entire response", () => {
    const fenced = "```json\n" + JSON.stringify(valid, null, 2) + "\n```"
    expect(extractJsonFromText(fenced)).toEqual(valid)
    expect(extractJsonFromText("```\n" + JSON.stringify(valid) + "\n```")).toEqual(valid)
  })

  test("returns undefined for an unterminated fence", () => {
    expect(extractJsonFromText("```json\n" + JSON.stringify(valid))).toBeUndefined()
  })

  test("returns undefined for prose around the object", () => {
    const prose = "Here is my decision:\n" + JSON.stringify(valid) + "\nThat is all."
    expect(extractJsonFromText(prose)).toBeUndefined()
  })

  test("returns undefined for prose after a closing fence", () => {
    const fenced = "```json\n" + JSON.stringify(valid) + "\n```\nDone."
    expect(extractJsonFromText(fenced)).toBeUndefined()
  })

  test("returns undefined for multiple candidate objects", () => {
    const text = 'First: {"a":1}\nThen: ' + JSON.stringify(valid)
    expect(extractJsonFromText(text)).toBeUndefined()
  })

  test("returns undefined for multiple fences", () => {
    const text =
      "```json\n" +
      JSON.stringify(valid, null, 2) +
      "\n```\n```json\n" +
      JSON.stringify(deny) +
      "\n```"
    expect(extractJsonFromText(text)).toBeUndefined()
  })

  test("parses an object whose strings contain braces and fences", () => {
    const tricky = { ...valid, rationale: 'contains { braces } and ``` fences " and quotes' }
    expect(extractJsonFromText("```json\n" + JSON.stringify(tricky) + "\n```")).toEqual(tricky)
  })

  test("returns undefined for truncated/unbalanced JSON", () => {
    const truncated = JSON.stringify(valid).slice(0, JSON.stringify(valid).length - 5)
    expect(extractJsonFromText(truncated)).toBeUndefined()
  })
})

describe("parseDecisionFromText ambiguity policy", () => {
  // An authorization reviewer must fail closed: an ambiguous response
  // (more than one decision candidate) escalates; the parser never picks one.
  test("valid allow followed by valid deny escalates", () => {
    const text = JSON.stringify(valid) + "\n" + JSON.stringify(deny)
    expect(parseDecisionFromText(text)).toBeUndefined()
  })

  test("valid deny followed by valid allow escalates", () => {
    const text = JSON.stringify(deny) + "\n" + JSON.stringify(valid)
    expect(parseDecisionFromText(text)).toBeUndefined()
  })

  test("fenced allow example followed by final bare deny escalates", () => {
    const text =
      "Example:\n```json\n" +
      JSON.stringify(valid) +
      "\n```\nFinal decision:\n" +
      JSON.stringify(deny)
    expect(parseDecisionFromText(text)).toBeUndefined()
  })

  test("two valid decisions of different sizes escalate", () => {
    const long = decision("allow", {
      rationale: "A much longer rationale that would win a longest-first heuristic.",
    })
    const text = JSON.stringify(long) + "\nHowever, the final decision is:\n" + JSON.stringify(deny)
    expect(parseDecisionFromText(text)).toBeUndefined()
  })
})

describe("parseDecisionFromText", () => {
  test("parses and validates a valid decision from bare JSON", () => {
    expect(parseDecisionFromText(JSON.stringify(valid))).toEqual(valid)
  })

  test("parses and validates from a full-response fence", () => {
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

  test("returns undefined for valid JSON with a missing required field", () => {
    const missing = { ...valid } as Record<string, unknown>
    delete missing.rationale
    expect(parseDecisionFromText(JSON.stringify(missing))).toBeUndefined()
  })

  test("returns undefined for prose with no parseable decision", () => {
    expect(parseDecisionFromText("I cannot decide safely.")).toBeUndefined()
  })
})
