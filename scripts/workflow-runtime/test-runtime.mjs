// Unit tests for the workflow runtime. Uses node --test (Node 22+) with
// the type-stripping loader (Node 25 ships .ts support stable; we rely on
// the existing tsx-import behavior already working in the round-trip
// script). Run via:
//
//   node --test scripts/workflow-runtime/test-runtime.mjs
//
// or via the npm script `npm run test:runtime`.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, stat, rm, mkdir } from "node:fs/promises"
import path2 from "node:path"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  ask,
  setRuntimeContext,
  setDefaultBridge,
  resolveOutputPath,
  messagePath,
  waitForFile,
  readJsonFile,
  writeJsonAtomic,
  WorkflowRuntimeError,
} from "../../quartz/widgets/workflow/runtime/index.ts"
import { createMockBridge } from "./mock-bridge.mjs"

async function workspace(name = "ws") {
  const dir = await mkdtemp(path.join(tmpdir(), `qpty-${name}-`))
  // Provide a workspace folder layout content/<workspaceId>.runtime/
  const contentRoot = path.join(dir, "content")
  await mkdir(contentRoot, { recursive: true })
  return { dir, contentRoot, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("resolveOutputPath: workspace mode joins runtime root", async () => {
  const ctx = {
    contentRoot: "/abs/content",
    defaultBridge: { baseUrl: "http://x" },
    workspaceId: "workflows/demo",
  }
  assert.equal(
    resolveOutputPath("messages/A.json", "messages", ctx),
    "/abs/content/workflows/demo.runtime/messages/A.json",
  )
  assert.equal(
    resolveOutputPath("X.json", "workspace", ctx),
    "/abs/content/workflows/demo.runtime/X.json",
  )
})

test("resolveOutputPath: absolute requires a leading /", () => {
  const ctx = {
    contentRoot: "/abs/content",
    defaultBridge: { baseUrl: "http://x" },
    workspaceId: "ws",
  }
  assert.throws(
    () => resolveOutputPath("relative/x.json", "absolute", ctx),
    /must be absolute/,
  )
  assert.equal(resolveOutputPath("/tmp/x.json", "absolute", ctx), "/tmp/x.json")
})

test("messagePath: appends .json when no recognized ext", () => {
  const ctx = {
    contentRoot: "/c",
    defaultBridge: { baseUrl: "x" },
    workspaceId: "w",
  }
  assert.equal(messagePath("research", ctx), "/c/w.runtime/messages/research.json")
  assert.equal(messagePath("research.md", ctx), "/c/w.runtime/messages/research.md")
})

test("waitForFile: finds an existing file immediately", async () => {
  const w = await workspace("waitfile-1")
  try {
    const fp = path.join(w.dir, "ready.json")
    await writeFile(fp, "{}")
    const snap = await waitForFile(fp, { timeoutMs: 500, stableMs: 0 })
    assert.equal(snap.exists, true)
    assert.ok(snap.size >= 0)
  } finally {
    await w.cleanup()
  }
})

test("waitForFile: waits for file that arrives later", async () => {
  const w = await workspace("waitfile-2")
  try {
    const fp = path.join(w.dir, "deferred.json")
    setTimeout(() => writeFile(fp, '{"hi":1}'), 80)
    const snap = await waitForFile(fp, { timeoutMs: 2000, stableMs: 0, intervalMs: 30 })
    assert.equal(snap.exists, true)
  } finally {
    await w.cleanup()
  }
})

test("waitForFile: requireUpdate ignores stale files", async () => {
  const w = await workspace("waitfile-3")
  try {
    const fp = path.join(w.dir, "stale.json")
    await writeFile(fp, "{}")
    const before = (await stat(fp)).mtimeMs
    setTimeout(() => writeFile(fp, '{"fresh":1}'), 80)
    const snap = await waitForFile(fp, {
      timeoutMs: 2000,
      stableMs: 0,
      intervalMs: 30,
      requireUpdate: true,
      mtimeFloor: before,
    })
    assert.ok(snap.mtimeMs > before)
  } finally {
    await w.cleanup()
  }
})

test("waitForFile: times out cleanly", async () => {
  const w = await workspace("waitfile-4")
  try {
    const fp = path.join(w.dir, "never.json")
    await assert.rejects(
      () => waitForFile(fp, { timeoutMs: 200, intervalMs: 50, stableMs: 0 }),
      /timeout/i,
    )
  } finally {
    await w.cleanup()
  }
})

test("writeJsonAtomic + readJsonFile round-trip", async () => {
  const w = await workspace("rw")
  try {
    const fp = path.join(w.dir, "x.json")
    await writeJsonAtomic(fp, { a: 1, b: ["x"] })
    const got = await readJsonFile(fp)
    assert.deepEqual(got, { a: 1, b: ["x"] })
  } finally {
    await w.cleanup()
  }
})

test("ask: file-output mode round-trips a JSON value", async () => {
  const w = await workspace("ask-file")
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    bridge.setAgent("A", async ({ outputFile, format }) => {
      // Simulate an agent writing structured output to the requested file.
      assert.ok(outputFile, "agent should receive an outputFile path")
      assert.equal(format, "json")
      // Mock-bridge will perform the write for us when we return reply.
      return { reply: { from: "A", value: 42 }, lastOutput: '{"from":"A","value":42}' }
    })

    const result = await ask("A", "say hi", {
      outputFile: "messages/a-out.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 4000,
    })
    assert.deepEqual(result.reply, { from: "A", value: 42 })
    assert.equal(result.state, "waiting_input")
    assert.ok(result.outputFile?.endsWith("messages/a-out.json"))

    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})

test("ask: PTY-extract fallback returns lastOutput when no outputFile", async () => {
  const w = await workspace("ask-pty")
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    bridge.setAgent("B", async () => ({ lastOutput: "the answer" }))

    const result = await ask("B", "any prompt", { timeoutMs: 4000 })
    assert.equal(result.reply, "the answer")
    assert.equal(result.state, "waiting_input")

    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})

test("ask: bad JSON in outputFile raises WorkflowRuntimeError", async () => {
  const w = await workspace("ask-badjson")
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    bridge.setAgent("C", async ({ outputFile }) => {
      // Write garbage; mock bridge would normally JSON-stringify the reply,
      // but we sidestep by handling the file ourselves and returning no reply.
      await mkdir(path2.dirname(outputFile), { recursive: true })
      const garbage = "not json {{ ::"
      await writeFile(outputFile, garbage, "utf8")
      return { lastOutput: "wrote garbage" }
    })

    await assert.rejects(
      () =>
        ask("C", "p", {
          outputFile: "messages/c.json",
          outputFileResolution: "messages",
          format: "json",
          timeoutMs: 3000,
        }),
      (e) => e instanceof WorkflowRuntimeError && e.code === "bad_json",
    )

    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})

test("ask: timeout fires when the agent never settles", async () => {
  const w = await workspace("ask-timeout")
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    // Hung agent: never returns, mock-bridge keeps state in "thinking".
    bridge.setAgent("D", async () => new Promise(() => {}))

    await assert.rejects(
      () => ask("D", "p", { timeoutMs: 400, poll: { intervalMs: 50 } }),
      (e) => e instanceof WorkflowRuntimeError && e.code === "timeout",
    )

    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})

test("ask: passes structured context as JSON code block in prompt", async () => {
  const w = await workspace("ask-ctx")
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    let receivedPrompt = ""
    bridge.setAgent("E", ({ prompt }) => {
      receivedPrompt = prompt
      return { lastOutput: "ok" }
    })

    await ask("E", "do thing", {
      context: { items: [1, 2, 3] },
      contextFormat: "json",
      timeoutMs: 2000,
    })
    assert.match(receivedPrompt, /\[CONTEXT\]/)
    assert.match(receivedPrompt, /"items"/)
    // JSON.stringify with indent emits the array elements on separate lines.
    assert.match(receivedPrompt, /1[\s\S]+2[\s\S]+3/)
    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})
