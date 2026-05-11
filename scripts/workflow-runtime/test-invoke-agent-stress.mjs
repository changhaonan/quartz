// Stress test for invokeAgent against a randomized agent simulator.
//
// 30 invocations, each picks a behavior from {normal, slow, hang,
// crash, partial, wrong_format, close} by weighted random. For each:
//   1. Record what behavior fired
//   2. Compare the invokeAgent outcome to the per-behavior expectation
//
// Assertions:
//   - Every fired behavior produced the expected resolution / error code
//   - Each behavior fired at least once (with the default weights and
//     the configured seed, 30 invocations covers all seven kinds)
//   - Test completes well under timeout (we cap each invocation at 500ms)

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
import { createAgentSimulator, expectedOutcomeFor } from "./agent-simulator.mjs"

test("stress (stratified): each behavior × 2 calls, both with and without outputFile", async () => {
  // Stratified > pure-weighted-random for coverage assertions: we
  // force-fire every behavior the simulator knows about, exactly N
  // times, with and without an outputFile. Guarantees every branch
  // of expectedOutcomeFor's hasOutput logic hits.
  const bridge = createMockBridge()
  const baseUrl = await bridge.start()
  setDefaultBridge({ baseUrl })
  const dir = await mkdtemp(path.join(tmpdir(), "qpty-stress-"))
  setRuntimeContext({ contentRoot: dir, workspaceId: "demo" })
  try {
    const sim = createAgentSimulator(bridge, { seed: 1337 })

    const BEHAVIORS = ["normal", "slow", "hang", "crash", "partial", "wrong_format", "close"]
    const REPEATS = 2
    /** @type {Array<{ behavior, actualKind, actualCode?, withOutput }>} */
    const results = []

    let i = 0
    for (const behavior of BEHAVIORS) {
      for (let rep = 0; rep < REPEATS; rep++) {
        const withOutput = rep === 0 // first rep has outputFile, second doesn't
        const sid = `sim-${behavior}-${rep}`
        sim.attach(sid, { force: behavior })
        const spec = {
          taskId: `task-${i++}`,
          body: `${behavior} test`,
          timeoutMs: 300,
          pollIntervalMs: 15,
        }
        if (withOutput) {
          spec.outputFile = `out-${behavior}-${rep}.json`
          spec.outputFileResolution = "messages"
          spec.format = "json"
        }
        let actualKind, actualCode
        try {
          await invokeAgent(sid, spec)
          actualKind = "success"
        } catch (err) {
          actualKind = "error"
          actualCode = err.code
        }
        results.push({ behavior, actualKind, actualCode, withOutput })
      }
    }

    // Coverage: every behavior fired REPEATS times.
    const tally = sim.report()
    for (const b of BEHAVIORS) {
      assert.equal(tally[b], REPEATS, `behavior ${b} fired ${tally[b]} times, expected ${REPEATS}`)
    }

    // Each call's outcome must match the per-behavior expectation.
    const mismatches = []
    for (const r of results) {
      const expected = expectedOutcomeFor(r.behavior, { outputFile: r.withOutput })
      const matches =
        expected.kind === r.actualKind &&
        (expected.kind !== "error" || expected.code === r.actualCode)
      if (!matches) {
        mismatches.push({ ...r, expected })
      }
    }
    if (mismatches.length > 0) {
      console.error("MISMATCHES:", JSON.stringify(mismatches, null, 2))
    }
    assert.equal(mismatches.length, 0, `${mismatches.length} outcomes diverged from expectations`)
  } finally {
    await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("stress (random): 40 weighted-random invocations, every observed behavior matches expectations", async () => {
  // Complement the stratified test with a randomized one — same
  // assertions on outcomes, but the behavior distribution is the
  // weighted random the simulator advertises by default. This catches
  // cases where the order or rate of behaviors matters (e.g. a kill
  // happening before push vs after).
  const bridge = createMockBridge()
  const baseUrl = await bridge.start()
  setDefaultBridge({ baseUrl })
  const dir = await mkdtemp(path.join(tmpdir(), "qpty-stress-rand-"))
  setRuntimeContext({ contentRoot: dir, workspaceId: "demo" })
  try {
    const sim = createAgentSimulator(bridge, { seed: 2024 })
    const N = 40
    /** @type {Array<{ behavior, actualKind, actualCode?, withOutput }>} */
    const results = []
    for (let i = 0; i < N; i++) {
      const sid = `rand-${i}`
      sim.attach(sid)
      const withOutput = i % 2 === 0
      const spec = {
        taskId: `task-${i}`,
        body: `task ${i}`,
        timeoutMs: 250,
        pollIntervalMs: 15,
      }
      if (withOutput) {
        spec.outputFile = `out-${i}.json`
        spec.outputFileResolution = "messages"
        spec.format = "json"
      }
      let actualKind, actualCode
      try {
        await invokeAgent(sid, spec)
        actualKind = "success"
      } catch (err) {
        actualKind = "error"
        actualCode = err.code
      }
      const lastEntry = [...sim.log].reverse().find((e) => e.sessionId === sid)
      results.push({ behavior: lastEntry.behavior, actualKind, actualCode, withOutput })
    }
    const mismatches = []
    for (const r of results) {
      const expected = expectedOutcomeFor(r.behavior, { outputFile: r.withOutput })
      const matches =
        expected.kind === r.actualKind &&
        (expected.kind !== "error" || expected.code === r.actualCode)
      if (!matches) mismatches.push({ ...r, expected })
    }
    if (mismatches.length > 0) {
      console.error("RANDOM MISMATCHES:", JSON.stringify(mismatches, null, 2))
    }
    assert.equal(mismatches.length, 0)
    // Don't assert distribution — that's the stratified test's job.
    // But do assert we touched at least 4 distinct behaviors so the
    // random pass actually adds coverage value.
    const distinct = new Set(results.map((r) => r.behavior))
    assert.ok(distinct.size >= 4, `random pass should hit ≥4 behaviors, got ${distinct.size}`)
  } finally {
    await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("stress: ack_timeout doesn't leak the polling fetch", async () => {
  // Failure-mode check: after a hang-induced ack_timeout, the open
  // /inbox?includeAcked=true fetch shouldn't keep the process alive
  // forever. We don't have a clean API to assert "no dangling fetches"
  // — instead we observe that another fresh invokeAgent on a
  // different session completes promptly after the timeout.
  const bridge = createMockBridge()
  const baseUrl = await bridge.start()
  setDefaultBridge({ baseUrl })
  const dir = await mkdtemp(path.join(tmpdir(), "qpty-stress2-"))
  setRuntimeContext({ contentRoot: dir, workspaceId: "demo" })
  try {
    bridge.ensureSession("A")
    bridge.setAgent("A", async () => {
      await new Promise(() => {}) // hang
      return { reply: { __skipHandoffAck: true } }
    })
    await assert.rejects(
      () => invokeAgent("A", { taskId: "hang", body: "x", timeoutMs: 100, pollIntervalMs: 25 }),
      (err) => err.code === "ack_timeout",
    )
    // Now a fresh session — should complete instantly.
    bridge.ensureSession("B")
    bridge.setAgent("B", () => ({ lastOutput: "ok" }))
    const t0 = Date.now()
    const r = await invokeAgent("B", { taskId: "fresh", body: "x", timeoutMs: 500, pollIntervalMs: 25 })
    assert.ok(r.ackedAt)
    assert.ok(Date.now() - t0 < 300, "fresh call should resolve fast")
  } finally {
    await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
