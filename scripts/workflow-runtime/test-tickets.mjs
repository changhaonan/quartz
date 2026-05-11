// Ticket-client round-trip test against the mock bridge. Verifies the
// quartz_pty side of the ticket integration: filing a ticket auto-spawns a
// session and surfaces its id; ask() against that id round-trips through
// the mock-bridge input handler; completeTicket sweeps the session.

import test from "node:test"
import assert from "node:assert/strict"

import {
  fileTicket,
  completeTicket,
  cancelTicket,
  releaseAllOpenTickets,
  ask,
  setRuntimeContext,
  setDefaultBridge,
  getRuntimeContext,
} from "../../quartz/widgets/workflow/runtime/index.ts"
import { createMockBridge } from "./mock-bridge.mjs"

async function setupBridge() {
  const bridge = createMockBridge()
  const baseUrl = await bridge.start()
  setDefaultBridge({ baseUrl })
  setRuntimeContext({ contentRoot: "/tmp/qpty-tickets", workspaceId: "demo" })
  // The runtime context is a process-wide singleton so the openTickets
  // map leaks between tests. Clear it at the top of each test so size
  // assertions reflect only what this test filed.
  const ctx = getRuntimeContext()
  if (ctx.openTickets) ctx.openTickets.clear()
  return bridge
}

test("fileTicket auto-spawns session for the role and returns its id", async () => {
  const bridge = await setupBridge()
  try {
    bridge.setRoleAgent("stamper", async ({ prompt }) => ({
      reply: `acked ${prompt.slice(0, 20)}`,
    }))

    const handle = await fileTicket({ role: "stamper", summary: "test stamp" })
    assert.match(handle.ticketId, /^tkt-mock-/)
    assert.match(handle.sessionId, /^mock-stamper-/)
    // The sessionId returned should actually exist on the bridge side.
    assert.ok(bridge.sessions.has(handle.sessionId), "session must exist")
  } finally {
    await bridge.stop()
  }
})

test("ask() against a ticketed session round-trips through the bridge", async () => {
  const bridge = await setupBridge()
  try {
    bridge.setRoleAgent("echoer", async ({ prompt }) => ({
      reply: `you said: ${(prompt.match(/echo:(.*)$/) ?? [, "?"])[1].trim().slice(0, 60)}`,
      lastOutput: "echo_done",
    }))

    const handle = await fileTicket({ role: "echoer", summary: "echo test" })
    // The mock bridge doesn't write outputFile-based replies, so use the
    // PTY-extract fallback: reply comes from facts.lastOutput.
    const result = await ask(handle.sessionId, "echo: hello world", {
      extract: "lastOutput",
      timeoutMs: 5000,
    })
    assert.equal(result.state, "waiting_input")
    assert.equal(result.reply, "echo_done")
    // Cleanup
    await completeTicket(handle)
    assert.ok(!bridge.sessions.has(handle.sessionId), "session swept by complete")
  } finally {
    await bridge.stop()
  }
})

test("releaseAllOpenTickets completes everything the run filed", async () => {
  const bridge = await setupBridge()
  try {
    bridge.setRoleAgent("stamper", async () => ({ reply: "ok" }))
    bridge.setRoleAgent("reader", async () => ({ reply: "ok" }))

    const h1 = await fileTicket({ role: "stamper", summary: "stamp" })
    const h2 = await fileTicket({ role: "reader", summary: "read" })
    // Both sessions live
    assert.ok(bridge.sessions.has(h1.sessionId))
    assert.ok(bridge.sessions.has(h2.sessionId))
    const open = getRuntimeContext().openTickets
    assert.equal(open?.size, 2)

    await releaseAllOpenTickets()

    // Both sessions swept
    assert.ok(!bridge.sessions.has(h1.sessionId), "stamper session swept")
    assert.ok(!bridge.sessions.has(h2.sessionId), "reader session swept")
    // The map is drained as each completion succeeds
    assert.equal(getRuntimeContext().openTickets?.size, 0)
  } finally {
    await bridge.stop()
  }
})

test("cancelTicket sweeps the session too (error-path cleanup)", async () => {
  const bridge = await setupBridge()
  try {
    bridge.setRoleAgent("worker", async () => ({ reply: "ok" }))
    const handle = await fileTicket({ role: "worker", summary: "doomed" })
    assert.ok(bridge.sessions.has(handle.sessionId))

    await cancelTicket(handle, { reason: "test" })
    assert.ok(!bridge.sessions.has(handle.sessionId), "cancel sweeps too")
    assert.equal(getRuntimeContext().openTickets?.size, 0)
  } finally {
    await bridge.stop()
  }
})

test("filing a ticket for an unknown role throws cleanly", async () => {
  const bridge = await setupBridge()
  try {
    // No setRoleAgent — mock returns ticket with no_assignee delivery.
    // The client should still POST succeed, but waitForAssigneeSession
    // will time out because the mock never resolves an assigneeSessionId.
    await assert.rejects(
      () => fileTicket({
        role: "ghost",
        summary: "no one home",
        awaitDeliveryMs: 800,
        pollIntervalMs: 100,
      }),
      (err) => {
        assert.equal(err.code, "ticket_no_session")
        return true
      },
    )
  } finally {
    await bridge.stop()
  }
})
