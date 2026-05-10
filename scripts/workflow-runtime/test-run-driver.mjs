// End-to-end tests for the run-driver pipeline: take a generated workflow
// source, compose a self-contained tsx-runnable script, spawn tsx, and
// verify it produces the expected result.json and exit code. Mirrors what
// the /api/workflow/run endpoint does internally.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  composeRunDriver,
  stripImports,
  isSafeWorkspaceId,
} from "../../quartz/widgets/workflow/runtime/run-driver.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..", "..")
const runtimePath = path.join(
  projectRoot,
  "quartz",
  "widgets",
  "workflow",
  "runtime",
  "index.ts",
)

async function setup(name) {
  const dir = await mkdtemp(path.join(tmpdir(), `qpty-run-${name}-`))
  const contentRoot = path.join(dir, "content")
  const runDir = path.join(contentRoot, "demo.runtime", "runs", "test")
  await mkdir(runDir, { recursive: true })
  return {
    dir,
    contentRoot,
    runDir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function runDriver({ runDir, contentRoot, workspaceId, source, entryName = "workflow", args }) {
  const runScriptPath = path.join(runDir, "run.ts")
  const argsPath = path.join(runDir, "args.json")
  const resultPath = path.join(runDir, "result.json")
  const driverSource = composeRunDriver({
    source,
    runtimePath,
    contentRoot,
    workspaceId,
    entryName,
    argsPath,
    resultPath,
  })
  await writeFile(runScriptPath, driverSource, "utf8")
  await writeFile(argsPath, JSON.stringify(args ?? []), "utf8")
  return new Promise((resolve) => {
    // Use bare `node` — Node 25 strips TS types natively, and tsx isn't
    // resolvable from a tmpdir outside the project's node_modules.
    const child = spawn("node", [runScriptPath], {
      cwd: contentRoot,
      env: { ...process.env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("exit", async (exitCode) => {
      let result = null
      try {
        result = JSON.parse(await readFile(resultPath, "utf8"))
      } catch {}
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, result, runScriptPath })
    })
    child.on("error", (e) =>
      resolve({ exitCode: 1, stdout, stderr: stderr + String(e), result: null, runScriptPath }),
    )
  })
}

test("stripImports: removes all top-level imports", () => {
  const src = `import { ask } from "../runtime"
import x from 'y'
import {
  a,
  b
} from "long-import";

export async function workflow() { return 1 }
`
  const stripped = stripImports(src)
  assert.equal(stripped.includes("import"), false, "no import lines should remain")
  assert.ok(stripped.includes("export async function workflow"))
})

test("isSafeWorkspaceId: accepts normal ids, rejects traversal", () => {
  assert.equal(isSafeWorkspaceId("workflows/demo"), true)
  assert.equal(isSafeWorkspaceId("foo-bar.baz/qux"), true)
  assert.equal(isSafeWorkspaceId(""), false)
  assert.equal(isSafeWorkspaceId("/abs"), false)
  assert.equal(isSafeWorkspaceId("../escape"), false)
  assert.equal(isSafeWorkspaceId("foo/../bar"), false)
  assert.equal(isSafeWorkspaceId("foo bar"), false)
})

test("run-driver: trivial workflow returns a constant", async () => {
  const w = await setup("constant")
  try {
    const source = `
export async function workflow() {
  return { greeting: "hi", answer: 42 }
}
`.trim()
    const out = await runDriver({
      runDir: w.runDir,
      contentRoot: w.contentRoot,
      workspaceId: "demo",
      source,
    })
    assert.equal(out.exitCode, 0, `exit=${out.exitCode}; stderr=${out.stderr.slice(-1000)}`)
    assert.ok(out.stdout.includes("__RUN_OK__"))
    assert.deepEqual(out.result, { ok: true, result: { greeting: "hi", answer: 42 } })
  } finally {
    await w.cleanup()
  }
})

test("run-driver: forwards entry args", async () => {
  const w = await setup("args")
  try {
    const source = `
export async function workflow(a, b) {
  return { sum: a + b, kind: typeof a }
}
`.trim()
    const out = await runDriver({
      runDir: w.runDir,
      contentRoot: w.contentRoot,
      workspaceId: "demo",
      source,
      args: [3, 4],
    })
    assert.equal(out.exitCode, 0)
    assert.deepEqual(out.result, { ok: true, result: { sum: 7, kind: "number" } })
  } finally {
    await w.cleanup()
  }
})

test("run-driver: workflow throws → exit code 1, error captured", async () => {
  const w = await setup("throw")
  try {
    const source = `
export async function workflow() {
  throw new Error("kaboom")
}
`.trim()
    const out = await runDriver({
      runDir: w.runDir,
      contentRoot: w.contentRoot,
      workspaceId: "demo",
      source,
    })
    assert.equal(out.exitCode, 1)
    assert.ok(out.stderr.includes("kaboom"), "stderr should include the error message")
    assert.equal(out.result?.ok, false)
    assert.equal(out.result?.error?.message, "kaboom")
  } finally {
    await w.cleanup()
  }
})

test("run-driver: workflow can use messagePath + writeJsonAtomic", async () => {
  const w = await setup("primitives")
  try {
    const source = `
export async function workflow() {
  const fp = messagePath("dropbox", { contentRoot: ${JSON.stringify(w.contentRoot)}, defaultBridge: { baseUrl: "" }, workspaceId: "demo" })
  await writeJsonAtomic(fp, { from: "workflow", at: Date.now() })
  return fp
}
`.trim()
    const out = await runDriver({
      runDir: w.runDir,
      contentRoot: w.contentRoot,
      workspaceId: "demo",
      source,
    })
    assert.equal(out.exitCode, 0, `exit=${out.exitCode}; stderr=${out.stderr.slice(-500)}`)
    assert.ok(typeof out.result.result === "string")
    assert.ok(out.result.result.includes("demo.runtime/messages/dropbox.json"))
    const written = JSON.parse(await readFile(out.result.result, "utf8"))
    assert.equal(written.from, "workflow")
  } finally {
    await w.cleanup()
  }
})
