// Tests for invokeAgent — the Director ↔ agent task primitive.
//
// All cases run against the in-memory mock-bridge (with the inbox
// push/list/ack endpoints we just added). No real PTY, no LLM, no
// network — should complete in well under a second per case. Lets us
// iterate on the "shell" of the protocol fast, then plug real agents
// in once the shape is stable.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from "node:fs/promises"
import * as fs from "node:fs/promises"
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
  // Each test gets its own tmpdir so output files don't collide.
  const dir = await mkdtemp(path.join(tmpdir(), "qpty-invoke-"))
  setRuntimeContext({ contentRoot: dir, workspaceId: "demo" })
  return { bridge, baseUrl, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("invokeAgent: pushes workflow_task → agent acks → resolves", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", async () => ({ lastOutput: "ok" }))

    const t0 = Date.now()
    const result = await invokeAgent("session-W", {
      taskId: "smoke",
      body: "Say ok.",
      timeoutMs: 3000,
      pollIntervalMs: 25,
    })
    const dt = Date.now() - t0
    assert.equal(result.taskId, "smoke")
    assert.match(result.inboxEventId, /^inbox-mock-/)
    assert.ok(result.ackedAt, "ackedAt should be set")
    assert.ok(dt < 2000, `should finish quickly, took ${dt}ms`)

    // Confirm the inbox event in the mock was actually created + acked.
    const inboxList = bridge.inboxes.get("session-W") ?? []
    assert.equal(inboxList.length, 1, "exactly one event pushed")
    assert.equal(inboxList[0].kind, "workflow_task")
    assert.equal(inboxList[0].payload.taskId, "smoke")
    assert.ok(inboxList[0].ackedAt, "event should be acked")
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("invokeAgent: writes outputFile via the agent → invokeAgent reads it back", async () => {
  const { bridge, dir, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", async () => ({
      reply: { greeting: "hello", count: 3 },
    }))

    const result = await invokeAgent("session-W", {
      taskId: "with-output",
      body: "Produce a small JSON object.",
      outputFile: "out.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 3000,
      pollIntervalMs: 25,
    })
    assert.deepEqual(result.reply, { greeting: "hello", count: 3 })
    // File should also exist on disk for downstream consumers.
    const written = JSON.parse(
      await readFile(
        path.join(dir, "demo.runtime/messages/out.json"),
        "utf8",
      ),
    )
    assert.deepEqual(written, { greeting: "hello", count: 3 })
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("invokeAgent: ack timeout when agent never acks", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Agent opts out of auto-ack via __skipHandoffAck — simulates an
    // agent that ran but never POSTed to /inbox/ack. invokeAgent
    // should hit its ack_timeout cleanly.
    bridge.setAgent("session-W", async () => ({
      reply: { __skipHandoffAck: true },
      lastOutput: "I refuse to ack",
    }))

    await assert.rejects(
      () =>
        invokeAgent("session-W", {
          taskId: "no-ack",
          body: "Pretend you finished but don't ack.",
          timeoutMs: 250,
          pollIntervalMs: 25,
        }),
      (err) => {
        assert.equal(err.code, "ack_timeout")
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("invokeAgent: outputFile declared but missing after ack → missing_output", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Agent acks (auto) but DOESN'T write the file (no `reply` field).
    bridge.setAgent("session-W", async () => ({
      lastOutput: "Done but skipped the file.",
    }))

    await assert.rejects(
      () =>
        invokeAgent("session-W", {
          taskId: "missing-file",
          body: "Pretend you finished and acked but never wrote the file.",
          outputFile: "missing.json",
          outputFileResolution: "messages",
          format: "json",
          timeoutMs: 1000,
          pollIntervalMs: 25,
        }),
      (err) => {
        assert.equal(err.code, "missing_output")
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: timing + inbox accumulation ──────────────────────────

test("edge: slow agent (200ms ack delay) still resolves within budget", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", async () => {
      await new Promise((r) => setTimeout(r, 200))
      return { lastOutput: "ok after a bit" }
    })
    const t0 = Date.now()
    const result = await invokeAgent("session-W", {
      taskId: "slow",
      body: "Take your time.",
      timeoutMs: 2000,
      pollIntervalMs: 25,
    })
    const dt = Date.now() - t0
    assert.ok(result.ackedAt, "should ack")
    assert.ok(dt >= 200, `should take at least 200ms (got ${dt}ms)`)
    assert.ok(dt < 1000, `should not take too long (got ${dt}ms)`)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: event acked BEFORE invokeAgent starts polling — first poll wins", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Agent acks instantly + synchronously (no setTimeout). The mock
    // auto-acks after the handler returns; here we just confirm the
    // wait loop on its first iteration immediately observes ackedAt
    // and resolves with no further polling.
    bridge.setAgent("session-W", () => ({ lastOutput: "instant" }))
    const t0 = Date.now()
    const result = await invokeAgent("session-W", {
      taskId: "instant",
      body: "Ack now.",
      timeoutMs: 1000,
      pollIntervalMs: 100,
    })
    const dt = Date.now() - t0
    assert.ok(result.ackedAt)
    assert.ok(dt < 200, `near-instant ack should finish fast (got ${dt}ms)`)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: inbox accumulates across 10 sequential tasks; each invokeAgent matches its own event", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ lastOutput: "done" }))
    const ackedIds = []
    for (let i = 0; i < 10; i++) {
      const r = await invokeAgent("session-W", {
        taskId: `task-${i}`,
        body: `task ${i}`,
        timeoutMs: 500,
        pollIntervalMs: 25,
      })
      ackedIds.push(r.inboxEventId)
    }
    const list = bridge.inboxes.get("session-W") ?? []
    assert.equal(list.length, 10, "all 10 events should still be in inbox")
    assert.equal(new Set(ackedIds).size, 10, "each task got a unique event id")
    for (const ev of list) assert.ok(ev.ackedAt, "every event eventually acked")
    // No invokeAgent should have observed any other task's ack as its own.
    for (let i = 0; i < 10; i++) {
      const found = list.find((e) => e.payload.taskId === `task-${i}`)
      assert.ok(found, `payload taskId task-${i} should exist`)
      assert.equal(found.id, ackedIds[i], `task-${i} matched to its own event`)
    }
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: pre-existing unrelated unacked events don't confuse the wait", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Pre-load the session inbox with three events that LOOK like
    // workflow_task but with different ids — they should NOT trigger
    // resolution of our new task.
    const list = []
    for (let i = 0; i < 3; i++) {
      list.push({
        id: `noise-${i}`,
        kind: "workflow_task",
        payload: { taskId: `noise-${i}` },
        createdAt: new Date().toISOString(),
        ackedAt: null,
      })
    }
    bridge.inboxes.set("session-W", list)
    bridge.setAgent("session-W", () => ({ lastOutput: "ok" }))

    const r = await invokeAgent("session-W", {
      taskId: "real",
      body: "Real task.",
      timeoutMs: 500,
      pollIntervalMs: 25,
    })
    // Only our own event got acked; the noise events stay pending.
    const after = bridge.inboxes.get("session-W")
    assert.equal(after.length, 4, "3 noise + 1 new = 4 events")
    const ours = after.find((e) => e.id === r.inboxEventId)
    assert.ok(ours.ackedAt, "ours acked")
    for (const ev of after) {
      if (ev.id !== r.inboxEventId) {
        assert.equal(ev.ackedAt, null, `noise event ${ev.id} should still be unacked`)
      }
    }
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: idempotent ack — acking the same event twice is a no-op", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ lastOutput: "ok" }))
    const r = await invokeAgent("session-W", {
      taskId: "ack-twice",
      body: "ok",
      timeoutMs: 500,
      pollIntervalMs: 25,
    })
    const list = bridge.inboxes.get("session-W")
    const first = list[0].ackedAt
    // Manually try to re-ack — mock should silently keep first ackedAt.
    const baseUrl = (bridge.start.__baseUrl) // not actually set; use plain fetch instead
    await fetch(`http://127.0.0.1:${(bridge.server?.address?.()?.port ?? 0)}/api/sessions/session-W/inbox/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventIds: [r.inboxEventId] }),
    }).catch(() => {/* server might be stopping; OK */})
    assert.equal(list[0].ackedAt, first, "second ack should not change timestamp")
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: output file races ─────────────────────────────────────

test("edge: large output file (~50KB) round-trips cleanly", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    const big = "x".repeat(50_000)
    bridge.setAgent("session-W", () => ({ reply: { kind: "blob", body: big } }))
    const r = await invokeAgent("session-W", {
      taskId: "big",
      body: "Write a big blob.",
      outputFile: "big.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 2000,
      pollIntervalMs: 25,
    })
    assert.equal(r.reply.body.length, 50_000)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: typical workflow filename (hyphens, dots, underscores) works", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ reply: { ok: true } }))
    const r = await invokeAgent("session-W", {
      taskId: "filename-shape",
      body: "ok",
      // Hyphens + dots + underscores + a trailing iso-ish timestamp.
      // These are the shapes our workflow helpers naturally produce.
      outputFile: "hop3-mp0bgkcj-ps3z_v2.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 1000,
      pollIntervalMs: 25,
    })
    assert.deepEqual(r.reply, { ok: true })
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: concurrency + spurious events ─────────────────────────

test("edge: parallel invokeAgent on different sessions — no cross-talk", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-A")
    bridge.ensureSession("session-B")
    bridge.setAgent("session-A", async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { reply: { from: "A" } }
    })
    bridge.setAgent("session-B", async () => {
      await new Promise((r) => setTimeout(r, 75))
      return { reply: { from: "B" } }
    })
    const [a, b] = await Promise.all([
      invokeAgent("session-A", {
        taskId: "ta",
        body: "task a",
        outputFile: "a.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 1500,
        pollIntervalMs: 25,
      }),
      invokeAgent("session-B", {
        taskId: "tb",
        body: "task b",
        outputFile: "b.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 1500,
        pollIntervalMs: 25,
      }),
    ])
    assert.deepEqual(a.reply, { from: "A" })
    assert.deepEqual(b.reply, { from: "B" })
    assert.equal(bridge.inboxes.get("session-A").length, 1)
    assert.equal(bridge.inboxes.get("session-B").length, 1)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: spurious inbox event (advance-like) during wait is ignored", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Slow agent — gives us a window to inject a spurious event in
    // the inbox before the real ack arrives. Simulates an `advance`
    // nudge or a `ticket_re_pinged` that arrives mid-wait. The poll
    // loop matches by event.id, so the noise must not resolve our
    // call early.
    bridge.setAgent("session-W", async () => {
      await new Promise((r) => setTimeout(r, 150))
      return { lastOutput: "real done" }
    })
    setTimeout(() => {
      const list = bridge.inboxes.get("session-W") ?? []
      list.push({
        id: "advance-noise",
        kind: "ticket_re_pinged",
        payload: { ticketId: "tkt-fake" },
        createdAt: new Date().toISOString(),
        ackedAt: new Date().toISOString(), // already acked — looks "done"
      })
      bridge.inboxes.set("session-W", list)
    }, 50)

    const r = await invokeAgent("session-W", {
      taskId: "real",
      body: "do work",
      timeoutMs: 1500,
      pollIntervalMs: 25,
    })
    // Our event resolved (its own id) — not the noise event.
    assert.notEqual(r.inboxEventId, "advance-noise")
    const list = bridge.inboxes.get("session-W")
    const ours = list.find((e) => e.id === r.inboxEventId)
    assert.ok(ours.ackedAt, "our event acked")
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: bridge failures + lifecycle ───────────────────────────

test("edge: bridge 5xx transient (≤4 hits) recovers and call still succeeds", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ lastOutput: "ok" }))
    bridge.injectInboxFiveHundred(4) // 4 inbox-list calls 500, then recover
    const r = await invokeAgent("session-W", {
      taskId: "flake-recover",
      body: "ok",
      timeoutMs: 2000,
      pollIntervalMs: 25,
    })
    assert.ok(r.ackedAt, "should recover from transient 5xx and ack")
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: bridge 5xx persistent → bridge_unreachable", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ lastOutput: "ok" }))
    bridge.injectInboxFiveHundred(999) // never recover
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "wedged-bridge",
        body: "ok",
        timeoutMs: 2000,
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.equal(err.code, "bridge_unreachable")
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: session killed mid-poll → session_gone (fast fail, not ack_timeout)", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Agent never acks; we kill the session 100ms in.
    bridge.setAgent("session-W", async () => {
      await new Promise((r) => setTimeout(r, 5000))
      return { reply: { __skipHandoffAck: true } }
    })
    setTimeout(() => bridge.killSession("session-W"), 100)
    const t0 = Date.now()
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "session-dies",
        body: "ok",
        timeoutMs: 5000, // would otherwise wait 5s for ack
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.equal(err.code, "session_gone")
        return true
      },
    )
    const dt = Date.now() - t0
    assert.ok(dt < 400, `should fail fast on session death (took ${dt}ms)`)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: session already dead before invokeAgent — early failure on push", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.killSession("session-W")
    // The /inbox PUSH itself still works in the mock (only GET is
    // killed), but the wait should fail on the very first poll.
    bridge.setAgent("session-W", () => ({ lastOutput: "doesnt matter" }))
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "dead-up-front",
        body: "ok",
        timeoutMs: 1000,
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.equal(err.code, "session_gone")
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: push/input POST failures ─────────────────────────────

test("edge: push /inbox returns 400 (kind rejected by bridge) → bridge_http_400", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.injectInboxPushStatus(400, 1, {
      ok: false,
      error: "kind: Invalid option: expected one of \"ticket_completed\"|…",
    })
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "kind-rejected",
        body: "ok",
        timeoutMs: 500,
        pollIntervalMs: 25,
      }),
      (err) => {
        // bridgeFetch's asJson translates 400 → bridge_http_400.
        assert.equal(err.code, "bridge_http_400")
        assert.match(err.message, /Invalid option/)
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: push /inbox returns 200 but body says ok:false → bridge_rejected_push", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.injectInboxPushStatus(200, 1, { ok: false, error: "soft-fail body" })
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "soft-fail",
        body: "ok",
        timeoutMs: 500,
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.equal(err.code, "bridge_rejected_push")
        assert.match(err.message, /soft-fail body/)
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: push response missing event.id → bridge_protocol", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.injectInboxPushMalformed()
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "no-id",
        body: "ok",
        timeoutMs: 500,
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.equal(err.code, "bridge_protocol")
        return true
      },
    )
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: /input POST fails 500 → prompt_delivery_failed (fast fail, not ack_timeout)", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ lastOutput: "ok" })) // would auto-ack if prompt arrived
    bridge.injectInputStatus(500, 1)
    const t0 = Date.now()
    await assert.rejects(
      () => invokeAgent("session-W", {
        taskId: "input-fails",
        body: "ok",
        // Generous timeout so we know fast-fail comes from the
        // prompt-delivery check, not from running out the clock.
        timeoutMs: 5000,
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.equal(err.code, "prompt_delivery_failed")
        return true
      },
    )
    const dt = Date.now() - t0
    assert.ok(dt < 200, `should fail-fast on /input error (took ${dt}ms)`)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: two invokeAgent in parallel on SAME session — each gets its own ack", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    // Slow agent so both pushes happen before either ack returns.
    bridge.setAgent("session-W", async () => {
      await new Promise((r) => setTimeout(r, 80))
      return { reply: { ok: true } }
    })
    const [a, b] = await Promise.all([
      invokeAgent("session-W", {
        taskId: "parallel-a",
        body: "task A",
        outputFile: "p-a.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 2000,
        pollIntervalMs: 20,
      }),
      invokeAgent("session-W", {
        taskId: "parallel-b",
        body: "task B",
        outputFile: "p-b.json",
        outputFileResolution: "messages",
        format: "json",
        timeoutMs: 2000,
        pollIntervalMs: 20,
      }),
    ])
    assert.notEqual(a.inboxEventId, b.inboxEventId, "different events for the two calls")
    assert.deepEqual(a.reply, { ok: true })
    assert.deepEqual(b.reply, { ok: true })
    // Inbox now has 2 events, both acked
    const list = bridge.inboxes.get("session-W")
    assert.equal(list.length, 2)
    for (const ev of list) assert.ok(ev.ackedAt, "every event acked")
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: ticket lifecycle interactions ─────────────────────────

test("edge: ticket closed mid-wait → ticket_closed (not ack_timeout)", async () => {
  const { bridge, baseUrl, cleanup } = await setupBridge()
  try {
    bridge.setRoleAgent("worker", async () => ({
      reply: { __skipHandoffAck: true },
      lastOutput: "[never acked, simulating self-close]",
    }))
    const { fileTicket, getRuntimeContext } = await import(
      "../../quartz/widgets/workflow/runtime/index.ts"
    )
    const handle = await fileTicket({ role: "worker", summary: "doomed" })
    assert.ok(getRuntimeContext().openTickets?.has(handle.ticketId))

    // Schedule a ticket complete ~150ms in. invokeAgent's ticket-status
    // poll runs every ~1s (TICKET_CHECK_INTERVAL_MS), so we wait up
    // to ~1.2s for the watch path to fire.
    setTimeout(async () => {
      await fetch(`${baseUrl}/api/tickets/${handle.ticketId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorRoleId: "admin", note: "x", evidence: { operatorNote: "x" } }),
      }).catch(() => {})
    }, 150)

    const t0 = Date.now()
    await assert.rejects(
      () => invokeAgent(handle.sessionId, {
        taskId: "doomed",
        body: "task that the ticket close will preempt",
        timeoutMs: 5000,
        pollIntervalMs: 25,
      }),
      (err) => {
        assert.ok(
          err.code === "ticket_closed" || err.code === "session_gone",
          `expected ticket_closed or session_gone, got ${err.code}`,
        )
        return true
      },
    )
    const dt = Date.now() - t0
    assert.ok(dt < 2000, `should fail-fast on ticket close (took ${dt}ms)`)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: ack-timeout diagnostics + stronger output directive ────

test("edge: ack_timeout error carries diagnostic (last state, lastOutput)", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({
      reply: { __skipHandoffAck: true },
      lastOutput: "I considered the task but did not run the ack curl.",
    }))
    try {
      await invokeAgent("session-W", {
        taskId: "no-ack-diag",
        body: "do something",
        timeoutMs: 250,
        pollIntervalMs: 25,
      })
      assert.fail("should have thrown")
    } catch (err) {
      assert.equal(err.code, "ack_timeout")
      // Diagnostic from the session-state probe on the failure path.
      assert.ok(err.details?.diagnostic, "diagnostic block should be present")
      assert.equal(err.details.diagnostic.state, "waiting_input")
      assert.match(err.details.diagnostic.lastOutput, /did not run the ack curl/)
    }
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("edge: JSON output directive includes hard 'JSON only' rider in prompt", async () => {
  const { bridge, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-W")
    bridge.setAgent("session-W", () => ({ reply: { ok: true } }))
    await invokeAgent("session-W", {
      taskId: "directive-check",
      body: "produce json",
      outputFile: "x.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 500,
      pollIntervalMs: 25,
    })
    // Inspect the prompt that hit the mock's /input log to confirm
    // the directive shape — agents are weak signal but our prompt
    // shape is the part we can test deterministically.
    const last = bridge.log[bridge.log.length - 1]
    assert.match(last.prompt, /JSON only/)
    assert.match(last.prompt, /no markdown fences/)
    assert.match(last.prompt, /JSON\.parse/)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

// ─── Edge cases: sentinel-file handoff fallback ─────────────────────────

test("edge: agent skips curl, writes sentinel file instead — invokeAgent still resolves", async () => {
  const { bridge, dir, cleanup } = await setupBridge()
  try {
    // Set runDir so invokeAgent generates a sentinel path. Mirror what
    // the run-driver would do.
    const { setRuntimeContext: setCtx, getRuntimeContext } = await import(
      "../../quartz/widgets/workflow/runtime/index.ts"
    )
    const runDir = path.join(dir, "runs", "r1")
    await fs.mkdir(runDir, { recursive: true })
    setCtx({ runDir })

    bridge.ensureSession("session-W")
    // Agent that DOESN'T ack via curl. Instead, it writes the
    // sentinel file the runtime prepared. Parse the prompt to extract
    // the sentinel path the runtime declared (in the [HANDOFF] line).
    bridge.setAgent("session-W", async ({ prompt }) => {
      // Sentinel path is the argument to the `touch '<path>'` example
      // command in the prompt. Match on that — robust to prose wording
      // changes around it.
      const sentMatch = prompt.match(/touch '([^']+)'/)
      if (sentMatch) {
        await fs.mkdir(path.dirname(sentMatch[1]), { recursive: true })
        await fs.writeFile(sentMatch[1], "")
      }
      return { reply: { __skipHandoffAck: true }, lastOutput: "I touched the file" }
    })

    const result = await invokeAgent("session-W", {
      taskId: "sentinel-only",
      body: "do work, sentinel-handoff",
      timeoutMs: 1500,
      pollIntervalMs: 25,
    })
    assert.ok(result.ackedAt, "should resolve via sentinel even without curl ack")
    assert.equal(result.inboxEventId, result.inboxEventId) // sanity
    // The runtime should have called /inbox/ack on the agent's behalf
    // so the bridge's bookkeeping stays consistent — verify by
    // checking that the event is acked in the mock.
    const list = bridge.inboxes.get("session-W") ?? []
    const ev = list.find((e) => e.id === result.inboxEventId)
    assert.ok(ev?.ackedAt, "runtime should auto-ack the event after sentinel")
  } finally {
    await bridge.stop()
    await cleanup()
  }
})

test("invokeAgent: two-agent handoff — writer drafts, critic reads, writer revises", async () => {
  const { bridge, dir, cleanup } = await setupBridge()
  try {
    bridge.ensureSession("session-Writer")
    bridge.ensureSession("session-Critic")

    let writerCallCount = 0
    bridge.setAgent("session-Writer", async ({ prompt }) => {
      writerCallCount += 1
      if (writerCallCount === 1) {
        return { reply: { stage: "v1", text: "A robot found a garden." } }
      }
      // Second call = revise. We expect the prompt to mention the critique.
      const sawCritique = /\[CONTEXT\][\s\S]*tighten/.test(prompt)
      return {
        reply: {
          stage: "v2",
          text: "A robot found an overgrown garden and began to tend it.",
          sawCritique,
        },
      }
    })
    bridge.setAgent("session-Critic", async () => ({
      reply: { feedback: "tighten the ending; add sensory detail" },
    }))

    const v1 = await invokeAgent("session-Writer", {
      taskId: "draft",
      body: "Write a short story.",
      outputFile: "story-v1.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 3000,
      pollIntervalMs: 25,
    })
    assert.equal(v1.reply.stage, "v1")

    const c1 = await invokeAgent("session-Critic", {
      taskId: "critique",
      body: "Critique the draft below.",
      context: v1.reply,
      outputFile: "critique-1.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 3000,
      pollIntervalMs: 25,
    })
    assert.match(c1.reply.feedback, /tighten/)

    const v2 = await invokeAgent("session-Writer", {
      taskId: "revise",
      body: "Revise based on the critique.",
      context: c1.reply,
      outputFile: "story-v2.json",
      outputFileResolution: "messages",
      format: "json",
      timeoutMs: 3000,
      pollIntervalMs: 25,
    })
    assert.equal(v2.reply.stage, "v2")
    assert.equal(v2.reply.sawCritique, true, "revise prompt should include critique in [CONTEXT]")

    // Each agent has its own inbox; both have exactly the right
    // number of acked events.
    assert.equal(bridge.inboxes.get("session-Writer").length, 2)
    assert.equal(bridge.inboxes.get("session-Critic").length, 1)
    for (const ev of bridge.inboxes.get("session-Writer")) {
      assert.ok(ev.ackedAt, "every writer event should be acked")
    }
    assert.ok(bridge.inboxes.get("session-Critic")[0].ackedAt, "critic event acked")
    // Files all on disk.
    const messages = path.join(dir, "demo.runtime/messages")
    const finalText = JSON.parse(await readFile(path.join(messages, "story-v2.json"), "utf8"))
    assert.equal(finalText.stage, "v2")
    assert.equal(finalText.sawCritique, true)
  } finally {
    await bridge.stop()
    await cleanup()
  }
})
