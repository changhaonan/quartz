// Bridge ticket client + per-run lifecycle scope.
//
// The bridge owns session lifecycle through its ticket system: filing a
// ticket auto-spawns an agent that can fulfill it; completing or
// cancelling the ticket sweeps the agent. The workflow runtime is a
// client: it files tickets to acquire agents, hands the resolved
// sessionIds to `ask()`, and registers each open ticket on the
// RuntimeContext so the run-driver can complete them in its finally
// block. No parallel ticket-lifecycle logic lives here — the bridge is
// the single source of truth.
//
// Edges and gotchas the next phase needs to think about:
//
//   - bridge's POST /api/tickets is a heavyweight "file a work request"
//     verb (assignee routing, dependency gating, etc.). We use only the
//     auto-spawn-and-deliver subset. As we exercise this in production we
//     may want a lighter "scope-only" ticket type bridge-side.
//
//   - The current `fileTicket` is one ticket → one session. Workflows
//     that want multiple stamps of the same role still end up funneling
//     through one auto-spawned session (because the second ticket finds
//     the live session and routes to it instead of spawning). That's
//     fine for v1; if we want N independent sessions, we'll need bridge
//     support for "force-spawn" or per-ticket isolation hints.
//
//   - completeTicket vs cancelTicket: complete is the success path;
//     cancel is for "the run errored, kill the agents." Both end up
//     sweeping scoped sessions. We use complete in the finally — if the
//     workflow threw we'll still want the sessions cleaned up, and the
//     bridge doesn't currently distinguish between the two for sweep
//     purposes.

import { bridgeFetch, asJson, resolveBridge } from "./bridge.ts"
import { getRuntimeContext } from "./ask.ts"
import {
  type BridgeEndpoint,
  type BridgeRef,
  WorkflowRuntimeError,
} from "./types.ts"

// ─── Types ────────────────────────────────────────────────────────────

export interface TicketSpec {
  /**
   * Which role should fulfill this ticket. Must match a role registered
   * on the bridge (GET /api/roles). Common ones for workflow use:
   *   - "generalist": catch-all
   *   - "quartz_workspace_operator": authored content / docs work
   */
  role: string
  /** Short human-readable label that shows up in ticket boards / traces. */
  summary: string
  /** Free-form body. Used by the assignee as context. Optional. */
  body?: string
  /**
   * Identity of the caller — required by the bridge's anti-anonymous-
   * filing check. Defaults to "admin" because the workflow runtime
   * issuing tickets is the local dev server (loopback-trusted), and the
   * "admin" role is the closest thing to "this is a system-internal
   * call" in the bridge's role registry. Override if you want a more
   * specific identity in the ticket trace.
   */
  fromRoleId?: string
  /**
   * Max time to wait for the bridge to deliver the ticket (auto-spawn +
   * route). Default 30s — long enough for cold-start, short enough that
   * a wedged bridge fails fast.
   */
  awaitDeliveryMs?: number
  /**
   * Polling interval while waiting for assigneeSessionId to appear on
   * the ticket after delivery. Default 200ms.
   */
  pollIntervalMs?: number
  /**
   * Where to look for the bridge. Falls back to the runtime context's
   * defaultBridge, which itself defaults to http://127.0.0.1:3210.
   */
  bridge?: BridgeRef
}

export interface TicketHandle {
  /** Bridge's ticket id (e.g. tkt-2026-…-xxxxxxxx). */
  ticketId: string
  /** The session the ticket got routed to. Use this for `ask(...)`. */
  sessionId: string
  /** The bridge endpoint this ticket lives on (for symmetric cleanup). */
  bridge: BridgeEndpoint
}

interface TicketRecord {
  id: string
  status?: string
  assigneeSessionId?: string
  assigneeRoleId?: string
  events?: Array<{ kind?: string; sessionId?: string }>
  [k: string]: unknown
}

interface TicketCreateResponse {
  ok: boolean
  ticket?: TicketRecord
  delivery?: { status: string; attempts?: number; ms?: number }
  error?: string
}

// ─── File / complete primitives ───────────────────────────────────────

/**
 * File a ticket and wait until the bridge has routed it to a live
 * session that's ready to receive input. Returns the ticket id and the
 * session id assigned to it. The ticket is registered with the runtime
 * context so the run-driver's finally block can complete it; callers
 * that want manual control can complete it themselves via
 * `completeTicket`.
 *
 * Two waits are involved:
 *   1. The bridge picks an assignee (auto-spawn + route). The
 *      `assigneeSessionId` field appears on the ticket record once this
 *      finishes — this is what `awaitDeliveryMs` budgets for.
 *   2. The freshly-spawned PTY needs a moment to come up before it can
 *      accept input. We poll the session until it reports a non-error
 *      state (best signal: `waiting_input`). Sending ask() too early
 *      hits 404 "Unknown session" because the session id is allocated
 *      before the PTY is registered.
 */
export async function fileTicket(spec: TicketSpec): Promise<TicketHandle> {
  const endpoint = resolveBridge(spec.bridge)
  const awaitMs = spec.awaitDeliveryMs ?? 30_000
  const pollMs = spec.pollIntervalMs ?? 200
  // Progress log — flows through subprocess stdout to runs/<id>/stdout.log
  // which the browser tails during the run. Single line per phase.
  console.log(`[ticket] filing role=${spec.role} summary="${spec.summary}"...`)
  const _t0 = Date.now()

  // The body is the only signal we get to the spawned agent on what to
  // do. We use the ticket as a *lifecycle anchor* — the actual work
  // happens through subsequent ask() calls on the session. So tell the
  // agent unambiguously: don't act on the summary alone, wait for input
  // on this session, and DON'T self-close. If the user provided their
  // own body, append our directive so any custom context the caller
  // wanted to inject is preserved.
  // The body is the only signal we get to the spawned agent on what the
  // ticket is for. We use the ticket purely as a session-lifecycle
  // anchor — actual work arrives as subsequent inputs on the session.
  // The directive has to balance two failure modes we saw in practice:
  //   1. Too sparse → agent assumes "nothing to do here", auto-closes.
  //   2. Too cautious ("wait quietly") → agent treats each task message
  //      as more directive and just acknowledges instead of executing.
  // Final phrasing aims to make the agent's contract crisp: "you are a
  // task executor, each message is a task, complete it, stay alive."
  const stayAliveBody = [
    spec.body ?? "",
    spec.body ? "\n\n---\n" : "",
    "[workflow-runtime directive]",
    "You are bound to this ticket as a task-execution endpoint for a workflow.",
    "Each subsequent message on this session is a SEPARATE TASK from the workflow runtime.",
    "Execute each task as instructed in its message body (including writing output files when asked).",
    "Reply with the result requested by that specific message — do not just acknowledge.",
    "Stay in `waiting_input` between tasks. Do NOT close this ticket;",
    "the workflow runtime will close it explicitly when its run finishes.",
  ].join(" ").replace(/\s+/g, " ").trim()

  const createRes = await bridgeFetch(endpoint, "POST", "/api/tickets", {
    fromRoleId: spec.fromRoleId ?? "admin",
    assigneeRoleId: spec.role,
    summary: spec.summary,
    body: stayAliveBody,
    awaitDelivery: true,
    awaitDeliveryTimeoutMs: Math.min(60_000, Math.max(500, awaitMs)),
  })
  const created = await asJson<TicketCreateResponse>(createRes, "ticket file")
  const ticket = created.ticket
  if (!ticket?.id) {
    throw new WorkflowRuntimeError(
      `bridge filed a ticket with no id: ${JSON.stringify(created).slice(0, 400)}`,
      "ticket_bad_response",
      { created },
    )
  }
  if (
    created.delivery &&
    created.delivery.status !== "delivered" &&
    created.delivery.status !== "no_assignee"
  ) {
    throw new WorkflowRuntimeError(
      `ticket ${ticket.id} delivery returned "${created.delivery.status}"`,
      "ticket_undelivered",
      { ticketId: ticket.id, delivery: created.delivery },
    )
  }

  const sessionId = await waitForAssigneeSession(
    endpoint,
    ticket.id,
    pollMs,
    awaitMs,
  )
  // The session id is set by bridge before the PTY is fully registered
  // (we hit 404 from ask() if we don't wait). Poll GET /api/sessions/:id
  // until the bridge reports a non-error reachable state.
  await waitForSessionReady(endpoint, sessionId, pollMs, awaitMs)

  const handle: TicketHandle = { ticketId: ticket.id, sessionId, bridge: endpoint }
  registerOpenTicket(handle)
  console.log(`[ticket] got ${ticket.id} → ${sessionId} (${((Date.now() - _t0) / 1000).toFixed(1)}s)`)
  return handle
}

async function waitForSessionReady(
  endpoint: BridgeEndpoint,
  sessionId: string,
  pollMs: number,
  totalBudgetMs: number,
): Promise<void> {
  const deadline = Date.now() + totalBudgetMs
  let lastSeen: string | null = null
  while (Date.now() < deadline) {
    const res = await bridgeFetch(
      endpoint,
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    )
    if (res.ok) {
      // Bridge wraps the session record under `session` in the GET
      // response (the same pattern POST /api/sessions uses). Mock bridges
      // return the flat shape for backwards-compat — accept both, since
      // the unit tests still drive this with the mock.
      const body = (await res.json()) as
        | { session?: { state?: string }; state?: string }
        | { state?: string }
      const wrapped = (body as { session?: { state?: string } }).session
      const state = wrapped?.state ?? (body as { state?: string }).state ?? null
      lastSeen = state
      // The earliest state we can reliably send input to. Bridge marks
      // freshly-spawned sessions as "uninited" → "starting" → "thinking"
      // (while the agent reads its bootstrap context) → "waiting_input".
      if (state === "waiting_input") return
      // "thinking" / "tool_running" are also reachable — the session
      // exists, it's just busy. ask() handles its own settle-wait.
      if (state === "thinking" || state === "tool_running") return
    }
    await sleep(pollMs)
  }
  throw new WorkflowRuntimeError(
    `session ${sessionId} never reached a sendable state within ${totalBudgetMs}ms${
      lastSeen ? `; last state: ${lastSeen}` : ""
    }`,
    "session_not_ready",
    { sessionId, lastSeen },
  )
}

async function waitForAssigneeSession(
  endpoint: BridgeEndpoint,
  ticketId: string,
  pollMs: number,
  totalBudgetMs: number,
): Promise<string> {
  const deadline = Date.now() + totalBudgetMs
  let lastError: string | null = null
  while (Date.now() < deadline) {
    const res = await bridgeFetch(endpoint, "GET", `/api/tickets/${encodeURIComponent(ticketId)}`)
    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean; ticket?: TicketRecord }
      const ticket = body.ticket
      const direct = String(ticket?.assigneeSessionId ?? "").trim()
      if (direct) return direct
      // Fallback: scan ticket events for an auto_spawned record. Some
      // routing paths attach the sessionId there before the top-level
      // assigneeSessionId field settles.
      for (const event of ticket?.events ?? []) {
        if (event?.kind === "auto_spawned" && event.sessionId) {
          return String(event.sessionId)
        }
      }
    } else {
      lastError = `${res.status} ${res.statusText}`
    }
    await sleep(pollMs)
  }
  throw new WorkflowRuntimeError(
    `ticket ${ticketId} routed but no session resolved within ${totalBudgetMs}ms${
      lastError ? `; last GET error: ${lastError}` : ""
    }`,
    "ticket_no_session",
    { ticketId },
  )
}

/**
 * Mark a ticket complete on the bridge. Bridge sweeps any session that
 * was auto-spawned for the ticket. Safe to call multiple times — second
 * call returns the bridge's "already complete" response which we treat
 * as a successful no-op.
 */
export async function completeTicket(
  handle: TicketHandle | string,
  opts: { bridge?: BridgeRef; operatorNote?: string } = {},
): Promise<void> {
  const ticketId = typeof handle === "string" ? handle : handle.ticketId
  const endpoint =
    typeof handle === "string" ? resolveBridge(opts.bridge) : handle.bridge
  // Bridge's complete endpoint routes on caller identity:
  //   assignee role/session closes → closed_by_assignee (needs `evidence`)
  //   admin cap closes             → closed_by_operator (needs `evidence.operatorNote`)
  // The workflow runtime files tickets as admin, so we're always on the
  // operator path. Pass operatorNote even when caller didn't supply one
  // (bridge rejects empties) — a short canonical note keeps the trace
  // honest about why this ticket closed.
  const operatorNote = opts.operatorNote ?? "workflow-runtime: run finished"
  const res = await bridgeFetch(
    endpoint,
    "POST",
    `/api/tickets/${encodeURIComponent(ticketId)}/complete`,
    { evidence: { operatorNote }, note: operatorNote },
  )
  if (!res.ok && res.status !== 409) {
    let bodyText = ""
    try {
      bodyText = await res.text()
    } catch {}
    throw new WorkflowRuntimeError(
      `ticket ${ticketId} complete failed: ${res.status} :: ${bodyText.slice(0, 200)}`,
      `ticket_complete_${res.status}`,
    )
  }
  unregisterOpenTicket(ticketId)
}

/**
 * Cancel a ticket. Use this on the error path — semantically distinct
 * from complete (the work didn't get done), but behaviourally similar:
 * bridge sweeps any auto-spawned session.
 */
export async function cancelTicket(
  handle: TicketHandle | string,
  opts: { reason?: string; bridge?: BridgeRef } = {},
): Promise<void> {
  const ticketId = typeof handle === "string" ? handle : handle.ticketId
  const endpoint =
    typeof handle === "string" ? resolveBridge(opts.bridge) : handle.bridge
  const res = await bridgeFetch(
    endpoint,
    "POST",
    `/api/tickets/${encodeURIComponent(ticketId)}/cancel`,
    { reason: opts.reason ?? "workflow_run_error" },
  )
  if (!res.ok && res.status !== 409) {
    let bodyText = ""
    try {
      bodyText = await res.text()
    } catch {}
    throw new WorkflowRuntimeError(
      `ticket ${ticketId} cancel failed: ${res.status} :: ${bodyText.slice(0, 200)}`,
      `ticket_cancel_${res.status}`,
    )
  }
  unregisterOpenTicket(ticketId)
}

// ─── Per-run scope (auto-cleanup) ─────────────────────────────────────

function registerOpenTicket(handle: TicketHandle): void {
  const ctx = getRuntimeContext()
  if (!ctx.openTickets) {
    ctx.openTickets = new Map()
  }
  ctx.openTickets.set(handle.ticketId, handle)
}

function unregisterOpenTicket(ticketId: string): void {
  const ctx = getRuntimeContext()
  ctx.openTickets?.delete(ticketId)
}

/**
 * Best-effort cleanup of every ticket the run opened. Called by the
 * run-driver's __main finally — survives workflow exceptions, won't
 * itself throw (errors are logged to stderr so the run.log still shows
 * them, but they don't override the workflow's own outcome).
 */
export async function releaseAllOpenTickets(): Promise<void> {
  const ctx = getRuntimeContext()
  const open = ctx.openTickets
  if (!open || open.size === 0) return
  const handles = Array.from(open.values())
  console.log(`[ticket] releasing ${handles.length} open ticket(s)...`)
  await Promise.all(
    handles.map(async (h) => {
      try {
        await completeTicket(h)
      } catch (e) {
        console.error(
          `[ticket] failed to complete ${h.ticketId} on run exit:`,
          (e as Error).message,
        )
      }
    }),
  )
  console.log(`[ticket] released`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
