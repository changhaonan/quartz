// Multi-agent interaction patterns — does the invokeAgent + workflow
// shell support diverse topologies, not just sequential pipelines?
//
// Four canonical shapes covered here, each one stressing a different
// part of the runtime/codegen surface:
//
//   1. Parallel fan-out      — one draft, N parallel critics, aggregator
//   2. Iterative refinement  — writer ↔ critic loop until score ≥ threshold
//   3. Branching triage      — router classifies, dispatches to specialist
//   4. Hub-and-spoke         — manager delegates sub-tasks to workers
//
// Mock-only — fast (< 1s total). The point is to prove the shell
// supports these patterns; once they pass here, building real-agent
// versions is mechanical (same as we did for two-agent-story).

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  invokeAgent,
  setRuntimeContext,
  setDefaultBridge,
} from "../../quartz/widgets/workflow/runtime/index.ts"
import { createMockBridge } from "./mock-bridge.mjs"

async function setupBridge() {
  const bridge = createMockBridge()
  const baseUrl = await bridge.start()
  setDefaultBridge({ baseUrl })
  const dir = await mkdtemp(path.join(tmpdir(), "qpty-patterns-"))
  setRuntimeContext({ contentRoot: dir, workspaceId: "demo" })
  return { bridge, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ─── Pattern 1: Parallel fan-out (ensemble critics) ─────────────────────

test("pattern: parallel fan-out — 3 critics evaluate same draft concurrently", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("writer")
    bridge.ensureSession("critic-A")
    bridge.ensureSession("critic-B")
    bridge.ensureSession("critic-C")
    bridge.ensureSession("aggregator")

    bridge.setAgent("writer", () => ({
      reply: { stage: "draft", text: "the quick brown fox" },
    }))
    bridge.setAgent("critic-A", async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { reply: { critic: "A", score: 0.7, note: "needs pacing" } }
    })
    bridge.setAgent("critic-B", async () => {
      await new Promise((r) => setTimeout(r, 70))
      return { reply: { critic: "B", score: 0.8, note: "good imagery" } }
    })
    bridge.setAgent("critic-C", async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { reply: { critic: "C", score: 0.6, note: "ending weak" } }
    })
    bridge.setAgent("aggregator", ({ prompt }) => {
      // aggregator sees all 3 critiques via [CONTEXT]
      const scores = (prompt.match(/"score":\s*([\d.]+)/g) ?? []).map((m) => Number(m.split(":")[1]))
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length
      return { reply: { avgScore: avg, criticCount: scores.length } }
    })

    const t0 = Date.now()
    // Director: draft, then 3 critics in parallel via Promise.all, then aggregate
    const draft = await invokeAgent("writer", {
      taskId: "draft",
      body: "write something",
      outputFile: "draft.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 1000,
      pollIntervalMs: 25,
    })
    const [ca, cb, cc] = await Promise.all([
      invokeAgent("critic-A", { taskId: "cA", body: "rate this", context: draft.reply, outputFile: "a.json", outputFileResolution: "messages", format: "json", timeoutMs: 1000, pollIntervalMs: 25 }),
      invokeAgent("critic-B", { taskId: "cB", body: "rate this", context: draft.reply, outputFile: "b.json", outputFileResolution: "messages", format: "json", timeoutMs: 1000, pollIntervalMs: 25 }),
      invokeAgent("critic-C", { taskId: "cC", body: "rate this", context: draft.reply, outputFile: "c.json", outputFileResolution: "messages", format: "json", timeoutMs: 1000, pollIntervalMs: 25 }),
    ])
    const dtParallel = Date.now() - t0
    const summary = await invokeAgent("aggregator", {
      taskId: "agg",
      body: "average the scores",
      context: [ca.reply, cb.reply, cc.reply],
      outputFile: "summary.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 1000,
      pollIntervalMs: 25,
    })
    const totalMs = Date.now() - t0

    assert.equal(summary.reply.criticCount, 3)
    assert.ok(Math.abs(summary.reply.avgScore - 0.7) < 0.01, `avg should be ~0.7, got ${summary.reply.avgScore}`)
    // Parallel critics should finish in ~max(50,70,30)=70ms, not sum=150ms.
    // Allow some slop for HTTP overhead.
    assert.ok(dtParallel < 250, `parallel critics should overlap (took ${dtParallel}ms)`)
    // Each critic was invoked once.
    assert.equal(bridge.inboxes.get("critic-A")?.length, 1)
    assert.equal(bridge.inboxes.get("critic-B")?.length, 1)
    assert.equal(bridge.inboxes.get("critic-C")?.length, 1)
    void totalMs
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Pattern 2: Iterative refinement loop ───────────────────────────────

test("pattern: iterative refinement — writer ↔ critic loop until score ≥ threshold", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("writer")
    bridge.ensureSession("critic")

    let writerRevisions = 0
    let criticInvocations = 0
    bridge.setAgent("writer", () => {
      writerRevisions += 1
      return { reply: { version: writerRevisions, text: `draft v${writerRevisions}` } }
    })
    bridge.setAgent("critic", () => {
      criticInvocations += 1
      // Score climbs each pass; threshold 0.8 met on 3rd pass (0.5, 0.7, 0.9).
      const score = [0.5, 0.7, 0.9][criticInvocations - 1] ?? 0.95
      return { reply: { score, feedback: `pass ${criticInvocations}` } }
    })

    // Director: draft, then refine until score ≥ 0.8 (cap at 5 to prevent runaway)
    let draft = await invokeAgent("writer", {
      taskId: "draft-0",
      body: "initial draft",
      outputFile: "v0.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 500,
      pollIntervalMs: 15,
    })
    const THRESHOLD = 0.8
    const MAX_ROUNDS = 5
    let finalScore = 0
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const critique = await invokeAgent("critic", {
        taskId: `critique-${round}`,
        body: "score the draft",
        context: draft.reply,
        outputFile: `c${round}.json`,
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 500,
        pollIntervalMs: 15,
      })
      finalScore = critique.reply.score
      if (finalScore >= THRESHOLD) break
      draft = await invokeAgent("writer", {
        taskId: `revise-${round}`,
        body: "revise based on feedback",
        context: critique.reply,
        outputFile: `v${round + 1}.json`,
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 500,
        pollIntervalMs: 15,
      })
    }
    assert.ok(finalScore >= THRESHOLD, `should converge above ${THRESHOLD}, got ${finalScore}`)
    // Writer: 1 initial + 2 revisions = 3 invocations (loop breaks after 3rd critique)
    assert.equal(writerRevisions, 3, `writer invocations: ${writerRevisions}`)
    // Critic: 3 invocations (0.5, 0.7, 0.9 — broke after 0.9)
    assert.equal(criticInvocations, 3, `critic invocations: ${criticInvocations}`)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Pattern 3: Branching triage ────────────────────────────────────────

test("pattern: branching triage — router classifies, dispatches to specialist", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("router")
    bridge.ensureSession("mathSpecialist")
    bridge.ensureSession("codeSpecialist")
    bridge.ensureSession("writingSpecialist")

    bridge.setAgent("router", ({ prompt }) => {
      // Router decides class from prompt content
      const body = prompt.toLowerCase()
      let category = "writing"
      if (body.includes("equation") || body.includes("math")) category = "math"
      else if (body.includes("code") || body.includes("function")) category = "code"
      return { reply: { category } }
    })
    bridge.setAgent("mathSpecialist", () => ({ reply: { handled: "math" } }))
    bridge.setAgent("codeSpecialist", () => ({ reply: { handled: "code" } }))
    bridge.setAgent("writingSpecialist", () => ({ reply: { handled: "writing" } }))

    async function routeAndHandle(query) {
      const cls = await invokeAgent("router", {
        taskId: `route-${Math.random().toString(36).slice(2, 6)}`,
        body: query,
        outputFile: "route.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 500,
        pollIntervalMs: 15,
      })
      const sessionByClass = {
        math: "mathSpecialist",
        code: "codeSpecialist",
        writing: "writingSpecialist",
      }
      const specialist = sessionByClass[cls.reply.category]
      assert.ok(specialist, `unknown category: ${cls.reply.category}`)
      return invokeAgent(specialist, {
        taskId: `handle-${cls.reply.category}`,
        body: query,
        outputFile: `out-${cls.reply.category}.json`,
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 500,
        pollIntervalMs: 15,
      })
    }

    const mathOut = await routeAndHandle("solve the equation 2x + 3 = 11")
    const codeOut = await routeAndHandle("write a function that reverses a string")
    const writeOut = await routeAndHandle("tell me a short story about a cat")

    assert.equal(mathOut.reply.handled, "math")
    assert.equal(codeOut.reply.handled, "code")
    assert.equal(writeOut.reply.handled, "writing")

    // Each specialist got exactly one task; the unused ones got zero.
    assert.equal(bridge.inboxes.get("mathSpecialist")?.length, 1)
    assert.equal(bridge.inboxes.get("codeSpecialist")?.length, 1)
    assert.equal(bridge.inboxes.get("writingSpecialist")?.length, 1)
    // Router got three.
    assert.equal(bridge.inboxes.get("router")?.length, 3)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Pattern 4: Hub-and-spoke (manager + workers) ───────────────────────

test("pattern: hub-and-spoke — manager decomposes task, delegates to workers, aggregates", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("manager")
    bridge.ensureSession("worker-1")
    bridge.ensureSession("worker-2")
    bridge.ensureSession("worker-3")

    bridge.setAgent("manager", ({ prompt }) => {
      // The manager is invoked twice in this pattern: once to plan (returns subtasks),
      // once to aggregate (returns combined). Distinguish by [CONTEXT] presence.
      const hasResults = /worker-1/.test(prompt) && /worker-2/.test(prompt) && /worker-3/.test(prompt)
      if (hasResults) {
        return { reply: { phase: "aggregate", final: "combined work product" } }
      }
      return {
        reply: {
          phase: "plan",
          subtasks: [
            { worker: "worker-1", task: "research sources" },
            { worker: "worker-2", task: "draft outline" },
            { worker: "worker-3", task: "fact check claims" },
          ],
        },
      }
    })
    bridge.setAgent("worker-1", () => ({ reply: { worker: "worker-1", result: "5 sources found" } }))
    bridge.setAgent("worker-2", () => ({ reply: { worker: "worker-2", result: "3-section outline" } }))
    bridge.setAgent("worker-3", () => ({ reply: { worker: "worker-3", result: "all 8 claims verified" } }))

    // Director: ask manager to plan
    const plan = await invokeAgent("manager", {
      taskId: "plan",
      body: "decompose this project",
      outputFile: "plan.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 500,
      pollIntervalMs: 15,
    })
    // Run all subtasks in parallel (each worker is a different session)
    const workerResults = await Promise.all(
      plan.reply.subtasks.map((st) =>
        invokeAgent(st.worker, {
          taskId: `do-${st.worker}`,
          body: st.task,
          outputFile: `${st.worker}.json`,
          outputFileResolution: "messages",
          format: "json",
          timeoutMs: 500,
          pollIntervalMs: 15,
        }),
      ),
    )
    // Send results back to manager for aggregation
    const summary = await invokeAgent("manager", {
      taskId: "aggregate",
      body: "combine worker results",
      context: workerResults.map((r) => r.reply),
      outputFile: "final.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 500,
      pollIntervalMs: 15,
    })

    assert.equal(summary.reply.phase, "aggregate")
    assert.equal(summary.reply.final, "combined work product")
    assert.equal(bridge.inboxes.get("manager")?.length, 2, "manager called twice (plan + aggregate)")
    assert.equal(bridge.inboxes.get("worker-1")?.length, 1)
    assert.equal(bridge.inboxes.get("worker-2")?.length, 1)
    assert.equal(bridge.inboxes.get("worker-3")?.length, 1)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Bonus: nested patterns ─────────────────────────────────────────────

test("pattern: nested — branching where one branch contains a parallel fan-out", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("router")
    bridge.ensureSession("simpleHandler")
    bridge.ensureSession("complexA")
    bridge.ensureSession("complexB")
    bridge.ensureSession("merger")

    bridge.setAgent("router", ({ prompt }) => ({
      reply: { complexity: prompt.includes("hard") ? "complex" : "simple" },
    }))
    bridge.setAgent("simpleHandler", () => ({ reply: { kind: "simple", answer: "easy" } }))
    bridge.setAgent("complexA", () => ({ reply: { kind: "A", answer: "complex A part" } }))
    bridge.setAgent("complexB", () => ({ reply: { kind: "B", answer: "complex B part" } }))
    bridge.setAgent("merger", ({ prompt }) => {
      const hasA = /complex A/.test(prompt)
      const hasB = /complex B/.test(prompt)
      return { reply: { merged: hasA && hasB ? "A+B merged" : "incomplete" } }
    })

    async function handle(query) {
      const cls = await invokeAgent("router", {
        taskId: `r-${Math.random().toString(36).slice(2, 6)}`,
        body: query,
        outputFile: "r.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 500,
        pollIntervalMs: 15,
      })
      if (cls.reply.complexity === "simple") {
        return invokeAgent("simpleHandler", {
          taskId: "s",
          body: query,
          outputFile: "s.json",
          outputFileResolution: "messages",
          format: "json",
          timeoutMs: 500,
          pollIntervalMs: 15,
        })
      }
      // Complex branch: parallel sub-agents then merge
      const [a, b] = await Promise.all([
        invokeAgent("complexA", { taskId: "ca", body: query, outputFile: "ca.json", outputFileResolution: "messages", format: "json", timeoutMs: 500, pollIntervalMs: 15 }),
        invokeAgent("complexB", { taskId: "cb", body: query, outputFile: "cb.json", outputFileResolution: "messages", format: "json", timeoutMs: 500, pollIntervalMs: 15 }),
      ])
      return invokeAgent("merger", {
        taskId: "m",
        body: "merge",
        context: [a.reply, b.reply],
        outputFile: "m.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 500,
        pollIntervalMs: 15,
      })
    }

    const easy = await handle("an easy question")
    const hard = await handle("a hard question")

    assert.equal(easy.reply.kind, "simple")
    assert.equal(hard.reply.merged, "A+B merged")
    // Simple branch never hit the complex pair.
    assert.equal(bridge.inboxes.get("simpleHandler")?.length, 1)
    assert.equal(bridge.inboxes.get("complexA")?.length, 1)
    assert.equal(bridge.inboxes.get("complexB")?.length, 1)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})
