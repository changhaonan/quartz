// Multi-agent telephone game integration test.
//
// Forward chain:  msg ─► A ─► B ─► C
//   each agent appends a stamp:  Forward: A, B, C
// Reverse chain: result ─► C ─► B ─► A
//   each agent strips its own stamp.
//
// Verifies the message arrives at the end of the round trip equal to the
// original — i.e. the runtime's file-based handoff didn't mangle, lose, or
// reorder bytes through any of the six PTY hops.
//
// All "agents" here are mock-bridge handlers; their behavior is
// deterministic so the test is not flaky.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  ask,
  setRuntimeContext,
  setDefaultBridge,
} from "../../quartz/widgets/workflow/runtime/index.ts"
import { createMockBridge } from "./mock-bridge.mjs"

async function setupWorkspace(name = "telephone") {
  const dir = await mkdtemp(path.join(tmpdir(), `qpty-${name}-`))
  const contentRoot = path.join(dir, "content")
  await mkdir(contentRoot, { recursive: true })
  return { dir, contentRoot, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * Make an agent that wraps incoming JSON {message, stamps} by appending its
 * own letter, then writes the result back as JSON.
 */
function stampingAgent(letter) {
  return async ({ prompt, outputFile, format }) => {
    if (format !== "json") {
      throw new Error(`stampingAgent ${letter}: expected json, got ${format}`)
    }
    // Pull the [CONTEXT] JSON block out of the prompt — that's the previous
    // step's output the runtime piped in.
    const ctxMatch = prompt.match(/\[CONTEXT\]\s*```json\s*([\s\S]*?)\s*```/)
    let payload = { message: "", stamps: [] }
    if (ctxMatch) {
      try {
        payload = JSON.parse(ctxMatch[1])
      } catch (e) {
        throw new Error(`stampingAgent ${letter}: bad context JSON: ${e.message}`)
      }
    }
    return {
      reply: {
        message: payload.message,
        stamps: [...(payload.stamps || []), letter],
      },
      lastOutput: `forwarded by ${letter}`,
    }
  }
}

/**
 * Make an agent that strips its own letter from the stamps array (verifies
 * order: it expects to be the LAST letter still present).
 */
function unstampingAgent(letter) {
  return async ({ prompt }) => {
    const ctxMatch = prompt.match(/\[CONTEXT\]\s*```json\s*([\s\S]*?)\s*```/)
    let payload = { message: "", stamps: [] }
    if (ctxMatch) payload = JSON.parse(ctxMatch[1])
    const stamps = [...(payload.stamps || [])]
    const last = stamps.pop()
    if (last !== letter) {
      throw new Error(
        `unstampingAgent ${letter}: expected last stamp to be ${letter}, got ${last}`,
      )
    }
    return {
      reply: { message: payload.message, stamps },
      lastOutput: `unstamped by ${letter}`,
    }
  }
}

test("telephone: forward A→B→C stamps message, reverse C→B→A unstamps it", async () => {
  const w = await setupWorkspace()
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    bridge.setAgent("A", stampingAgent("A"))
    bridge.setAgent("B", stampingAgent("B"))
    bridge.setAgent("C", stampingAgent("C"))

    const original = "the quick brown fox jumps over the lazy dog"

    // ─── Forward: A → B → C ──────────────────────────────────────────
    const stage1 = await ask("A", "stamp the message", {
      context: { message: original, stamps: [] },
      outputFile: "fwd-A.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.deepEqual(stage1.reply, {
      message: original,
      stamps: ["A"],
    })

    const stage2 = await ask("B", "stamp the message", {
      context: stage1.reply,
      outputFile: "fwd-B.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.deepEqual(stage2.reply, {
      message: original,
      stamps: ["A", "B"],
    })

    const stage3 = await ask("C", "stamp the message", {
      context: stage2.reply,
      outputFile: "fwd-C.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.deepEqual(stage3.reply, {
      message: original,
      stamps: ["A", "B", "C"],
    })

    // Verify the message text didn't drift across three hops.
    assert.equal(
      stage3.reply.message,
      original,
      "message text should be byte-identical after forward chain",
    )

    // ─── Reverse: C → B → A (each strips its own stamp) ──────────────
    bridge.setAgent("A", unstampingAgent("A"))
    bridge.setAgent("B", unstampingAgent("B"))
    bridge.setAgent("C", unstampingAgent("C"))

    const back1 = await ask("C", "unstamp", {
      context: stage3.reply,
      outputFile: "rev-C.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.deepEqual(back1.reply, {
      message: original,
      stamps: ["A", "B"],
    })

    const back2 = await ask("B", "unstamp", {
      context: back1.reply,
      outputFile: "rev-B.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.deepEqual(back2.reply, {
      message: original,
      stamps: ["A"],
    })

    const back3 = await ask("A", "unstamp", {
      context: back2.reply,
      outputFile: "rev-A.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.deepEqual(back3.reply, {
      message: original,
      stamps: [],
    })

    // ─── Final integrity check: all six message files contain a payload
    // with the original message string verbatim. This is the strict
    // "telephone-game didn't garble the bytes" assertion.
    const messagesDir = path.join(w.contentRoot, "demo.runtime", "messages")
    for (const name of ["fwd-A.json", "fwd-B.json", "fwd-C.json", "rev-A.json", "rev-B.json", "rev-C.json"]) {
      const text = await readFile(path.join(messagesDir, name), "utf8")
      const parsed = JSON.parse(text)
      assert.equal(parsed.message, original, `${name} preserved original message`)
    }

    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})

test("telephone: tricky payloads survive the chain", async () => {
  const w = await setupWorkspace("tricky")
  try {
    setRuntimeContext({ contentRoot: w.contentRoot, workspaceId: "demo" })
    const bridge = createMockBridge()
    const baseUrl = await bridge.start()
    setDefaultBridge({ baseUrl })

    bridge.setAgent("A", stampingAgent("A"))
    bridge.setAgent("B", stampingAgent("B"))

    const tricky = [
      "newlines\nwith\nlots\nof\nlines",
      "quotes \"double\" and 'single'",
      'backslashes \\ and tabs\there',
      "unicode 中文 ✓ 🎉",
      "json-y { brackets } and: colons",
      "long " + "x".repeat(2000),
    ].join("\n---\n")

    const stage1 = await ask("A", "stamp", {
      context: { message: tricky, stamps: [] },
      outputFile: "tricky-A.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    const stage2 = await ask("B", "stamp", {
      context: stage1.reply,
      outputFile: "tricky-B.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 5000,
    })
    assert.equal(
      stage2.reply.message,
      tricky,
      "tricky payload should survive A→B byte-identical",
    )
    assert.deepEqual(stage2.reply.stamps, ["A", "B"])

    await bridge.stop()
  } finally {
    await w.cleanup()
  }
})
