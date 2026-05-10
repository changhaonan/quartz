// Direct test runner that prints errors immediately. Used to diagnose
// what node --test is hiding.

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  ask,
  setRuntimeContext,
  setDefaultBridge,
  resolveOutputPath,
  WorkflowRuntimeError,
} from "../../quartz/widgets/workflow/runtime/index.ts"
import { createMockBridge } from "./mock-bridge.mjs"

let pass = 0
let fail = 0
async function run(name, fn) {
  try {
    await fn()
    console.log(`✔ ${name}`)
    pass++
  } catch (e) {
    console.error(`✖ ${name}`)
    console.error(`   ${e.stack || e.message || e}`)
    fail++
  }
}

await run("resolveOutputPath: workspace mode joins runtime root", () => {
  const ctx = {
    contentRoot: "/abs/content",
    defaultBridge: { baseUrl: "http://x" },
    workspaceId: "workflows/demo",
  }
  const got1 = resolveOutputPath("messages/A.json", "messages", ctx)
  console.log("  got1=", got1)
  const got2 = resolveOutputPath("X.json", "workspace", ctx)
  console.log("  got2=", got2)
})

await run("ask: file-output mode round-trips a JSON value", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qpty-ask-"))
  const contentRoot = path.join(dir, "content")
  await mkdir(contentRoot, { recursive: true })
  setRuntimeContext({ contentRoot, workspaceId: "demo" })
  const bridge = createMockBridge()
  const baseUrl = await bridge.start()
  console.log("  bridge at", baseUrl)
  setDefaultBridge({ baseUrl })

  bridge.setAgent("A", async ({ outputFile, format, prompt }) => {
    console.log("  agent A invoked, outputFile=", outputFile, "format=", format)
    console.log("  prompt[0:200]=", prompt.slice(0, 200))
    return { reply: { from: "A", value: 42 }, lastOutput: '{"from":"A","value":42}' }
  })

  try {
    const result = await ask("A", "say hi", {
      outputFile: "a-out.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 4000,
    })
    console.log("  result=", JSON.stringify(result))
  } finally {
    await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(`\nresult: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
