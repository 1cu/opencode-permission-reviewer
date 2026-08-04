import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { enrichGitEvidence } from "../src/git-evidence.ts"
import { request } from "./helpers.ts"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function git(directory: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: directory })
}

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "approval-reviewer-git-"))
  temporaryDirectories.push(directory)
  await git(directory, ["init", "-b", "staging"])
  await git(directory, ["config", "user.email", "reviewer@example.invalid"])
  await git(directory, ["config", "user.name", "Reviewer Test"])
  await writeFile(join(directory, "target.py"), "before = 1\n")
  await writeFile(join(directory, "unrelated.py"), "before = 1\n")
  await git(directory, ["add", "target.py", "unrelated.py"])
  await git(directory, ["commit", "-m", "fixture"])
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("Git state evidence enrichment", () => {
  test("separates preexisting staging from files a compound command plans to add", async () => {
    const directory = await repository()
    await writeFile(join(directory, "unrelated.py"), "before = 2\n")
    await git(directory, ["add", "unrelated.py"])
    await writeFile(join(directory, "target.py"), "before = 3\n")
    const command = 'git add target.py && git commit -m "bounded change"'
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      24_000,
    )
    expect(result.text).toContain("GIT_STATE_ANALYSIS")
    expect(result.text).toContain('"branch": "staging"')
    expect(result.text).toContain('"commitRequested": true')
    expect(result.text).toContain('"plannedAdd"')
    expect(result.text).toContain("target.py")
    expect(result.text).toContain('"preexistingStaged"')
    expect(result.text).toContain("unrelated.py")
  })

  test("shows the bounded diff that checkout would discard", async () => {
    const directory = await repository()
    await writeFile(join(directory, "target.py"), "before = 99\n")
    const command = "git checkout HEAD -- target.py"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      24_000,
    )
    expect(result.text).toContain('"discardTargets"')
    expect(result.text).toContain("target.py")
    expect(result.text).toContain('"affectedTargetNumstat": "1\\t1\\ttarget.py')
  })

  test("uses the repository selected by cd or git -C", async () => {
    const outer = await mkdtemp(join(tmpdir(), "approval-reviewer-git-outer-"))
    temporaryDirectories.push(outer)
    const directory = await repository()
    await writeFile(join(directory, "target.py"), "selected = true\n")

    for (const command of [
      `cd ${directory} && git checkout HEAD -- target.py`,
      `git -C ${directory} checkout HEAD -- target.py`,
    ]) {
      const result = await enrichGitEvidence(
        request({ patterns: [command], metadata: { command } }),
        outer,
        24_000,
      )
      expect(result.text).toContain(`"repositoryRoot": "${directory}"`)
      expect(result.text).toContain('"branch": "staging"')
      expect(result.text).toContain('"affectedTargetNumstat": "1\\t1\\ttarget.py')
    }
  })

  test("marks shell-expanded planned paths as unresolved", async () => {
    const directory = await repository()
    const command = 'git add "locales/$locale/messages.json" && git commit -m i18n'
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      24_000,
    )
    expect(result.text).toContain('"unresolvedPlannedPaths"')
    expect(result.text).toContain("$locale")
  })

  test("fails closed as unavailable outside a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-reviewer-no-git-"))
    temporaryDirectories.push(directory)
    const command = "git commit -m test"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      8_000,
    )
    expect(result.text).toContain('"status": "unavailable"')
    expect(result.text).toContain("not a git repository")
  })
})
