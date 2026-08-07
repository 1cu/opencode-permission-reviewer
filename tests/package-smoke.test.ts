import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CWD = import.meta.dir + "/.."

// Build a real tarball once (npm pack runs `prepare`, which rebuilds dist) and
// inspect it with tar. This avoids depending on npm's stdout formatting (which
// emits non-JSON banners/notices in some environments) and validates what would
// actually be published. Nothing is uploaded.
//
// Pack lazily inside the tests rather than in beforeAll: npm pack + prepare can
// exceed the default hook timeout on slow runners, and not every supported Bun
// release accepts a timeout option on beforeAll. Per-test timeouts (third arg)
// are the portable path.
let tmpDir: string | undefined
let tgzPath: string | undefined

function packOnce(): string {
  if (tgzPath !== undefined) return tgzPath
  tmpDir = mkdtempSync(join(tmpdir(), "reviewer-pkg-"))
  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--pack-destination", tmpDir],
    cwd: CWD,
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(pack.exitCode).toBe(0)
  const name = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"))
  expect(name).toBeTruthy()
  tgzPath = join(tmpDir, name!)
  return tgzPath
}

afterAll(() => {
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
})

async function listTarball(path: string): Promise<string[]> {
  const proc = Bun.spawn({ cmd: ["tar", "-tzf", path], stdout: "pipe", stderr: "pipe" })
  const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) throw new Error("tar list failed")
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((entry) => entry.replace(/^package\//, ""))
    .sort()
}

async function readFromTarball(path: string, member: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["tar", "-xOzf", path, `package/${member}`],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) throw new Error(`tar extract ${member} failed`)
  return text
}

describe("npm pack ship set", () => {
  test("the tarball contains the dist bundle and docs, nothing else", async () => {
    const files = await listTarball(packOnce())

    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "NOTICE",
      "SECURITY.md",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/tui.js",
      "dist/tui.d.ts",
      "dist/explain.js",
    ]) {
      expect(files).toContain(required)
    }

    // Exactly one shared types chunk (its hash suffix varies).
    const dtsChunks = files.filter((f) => /^dist\/ui-state-[a-z0-9]+\.d\.ts$/i.test(f))
    expect(dtsChunks.length).toBe(1)

    // Nothing from src/, tests/, config, or gitignored/personal files may ship.
    const forbidden = files.filter(
      (f) =>
        f.startsWith("src/") ||
        f.startsWith("tests/") ||
        f.startsWith("scripts/") ||
        f.startsWith(".github/") ||
        f.startsWith("node_modules/") ||
        f === "AGENTS.md" ||
        f === "CONTRIBUTING.md" ||
        f === "tsup.config.ts" ||
        f === "tsconfig.json" ||
        f === "eslint.config.ts" ||
        f === ".gitignore" ||
        f === ".prettierrc.json" ||
        f === ".prettierignore" ||
        f === "bun.lock" ||
        f.endsWith("-plan.md"),
    )
    expect(forbidden).toEqual([])
  }, 120_000)

  test("the packaged package.json is public and points at dist", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as Record<
      string,
      unknown
    >
    expect(pkg.private).toBeUndefined()
    expect(pkg.main).toBe("./dist/index.js")
    expect(pkg.types).toBe("./dist/index.d.ts")
    const exports = pkg.exports as Record<string, Record<string, string>>
    expect(exports?.["."]?.import).toBe("./dist/index.js")
    expect(exports?.["./tui"]?.import).toBe("./dist/tui.js")
  }, 120_000)
})
