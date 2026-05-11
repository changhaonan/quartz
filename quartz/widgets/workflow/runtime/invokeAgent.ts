// invokeAgent — the "Director ↔ agent" task primitive.
//
// Model (per the user's design):
//   * The workflow subprocess is the Director.
//   * Each call here is one task: start → execute → end.
//   * Director hands the task to the agent through bridge's inbox API
//     (push a `workflow_task` event → that returns an `event.id`).
//   * Director ALSO drops the task body + ack instructions into the
//     agent's PTY (via POST /input) so the agent has the prompt in
//     front of it.
//   * Agent does the work, writes any declared output file, then
//     POSTs the event.id back to /inbox/ack — that ack IS the
//     handoff signal.
//   * Director long-polls /inbox?includeAcked=true watching for the
//     event's ackedAt to populate, then optionally reads the output
//     file as the task's return value.
//
// Why this instead of the older ask() PTY-state-extract path:
//   * No screen scraping. The agent's "I'm done" is one explicit POST,
//     not a state transition we infer by polling /api/sessions/:id.
//   * No file-mtime stability tricks. Output file is data, not signal.
//   * Director and agent only exchange messages through documented
//     bridge endpoints — no in-band sentinels, no special timing.
//
// Bridge surface used (all pre-existing except the event kind):
//   * POST /api/sessions/:id/inbox       — push a workflow_task event
//   * POST /api/sessions/:id/input       — drop prompt into PTY
//   * GET  /api/sessions/:id/inbox?includeAcked=true — poll for ack
//
// The bridge needs `workflow_task` in EVENT_KINDS (one-line change in
// claude_pty/lib/inbox.js); without it, the inbox push 400s.

import path from "node:path"
import { promises as fs } from "node:fs"
import { bridgeFetch, asJson, resolveBridge } from "./bridge.ts"
import { readByFormat, detectFormat, resolveOutputPath } from "./files.ts"
import { getRuntimeContext } from "./ask.ts"
import {
  type BridgeEndpoint,
  type BridgeRef,
  type RuntimeContext,
  WorkflowRuntimeError,
} from "./types.ts"

export interface InvokeAgentSpec {
  /** Free-form task body. Goes into the PTY prompt verbatim. */
  body: string
  /**
   * Optional human-readable task id. Surfaces in logs and on the
   * pushed inbox event. Defaults to a short random id.
   */
  taskId?: string
  /**
   * Workspace-relative path the agent should write its output to.
   * The runtime resolves it (`outputFileResolution`), tells the
   * agent the absolute path, and reads it back as the task's reply
   * once the ack arrives.
   */
  outputFile?: string
  outputFileResolution?: "workspace" | "messages" | "absolute" | "cwd"
  /** Format for parsing outputFile. Auto-detected from extension if omitted. */
  format?: "json" | "text" | "markdown" | "raw"
  /**
   * Optional structured context to embed verbatim as a fenced code
   * block in the prompt. Useful for passing one task's output into
   * the next without quoting JSON by hand.
   */
  context?: unknown
  contextFormat?: "json" | "yaml" | "markdown" | "text"
  /**
   * Max wall-clock the Director will wait for the agent's ack.
   * Default 600s (10 min) — long enough for thoughtful work, short
   * enough that a stuck agent fails fast.
   */
  timeoutMs?: number
  /**
   * Poll interval while watching for ack. Default 250ms — every
   * ~quarter-second checks if the bridge has flipped the inbox
   * event's ackedAt. Tight enough to feel responsive, loose enough
   * to not hammer.
   */
  pollIntervalMs?: number
  /** Bridge override (defaults to runtime context default). */
  bridge?: BridgeRef
}

export interface InvokeAgentResult<T = unknown> {
  /** What the agent wrote to outputFile (parsed per format), if any. */
  reply?: T
  /** Absolute path the agent was told to write to, if outputFile was set. */
  outputFile?: string
  /** The inbox event the workflow pushed; useful for traces / debug. */
  taskId: string
  inboxEventId: string
  /** When the ack arrived. */
  ackedAt: string
  /** ms from the inbox push to the ack. */
  durationMs: number
}

interface InboxEvent {
  id: string
  kind: string
  payload: Record<string, unknown>
  createdAt: string
  ackedAt?: string | null
}

interface InboxPushResponse {
  ok: boolean
  event: InboxEvent
  error?: string
}

interface InboxListResponse {
  ok: boolean
  events: InboxEvent[]
}

function nextTaskId(): string {
  return "tk-" + Math.random().toString(36).slice(2, 10)
}

function buildPromptForAgent(args: {
  sessionId: string
  body: string
  inboxEventId: string
  outputAbsolutePath?: string
  outputFormat?: string
  context?: unknown
  contextFormat?: "json" | "yaml" | "markdown" | "text"
  bridgeBaseUrl: string
  sentinelPath?: string
}): string {
  const lines: string[] = []
  lines.push(args.body)
  if (args.context !== undefined) {
    lines.push("")
    lines.push("[CONTEXT]")
    lines.push(formatContext(args.context, args.contextFormat ?? "json"))
  }
  if (args.outputAbsolutePath) {
    lines.push("")
    const fmt = args.outputFormat ?? "text"
    let directive = `[OUTPUT] Write to ${args.outputAbsolutePath} as ${fmt}.`
    // Format-specific compliance riders. Agents often add preambles
    // ("Here is your JSON:") or markdown fences around JSON; both
    // break our downstream parse. Spell out the contract.
    if (fmt === "json") {
      directive += " JSON only — no preamble, no markdown fences, no explanation. Must parse with JSON.parse."
    } else if (fmt === "markdown") {
      directive += " Markdown body only. No surrounding fences."
    } else {
      directive += " Plain text body only. No commentary, no surrounding labels."
    }
    lines.push(directive)
  }
  lines.push("")
  lines.push("[HANDOFF]")
  // Keep this short and procedural. Earlier wording ("IMPORTANT
  // ORDERING: ... verify it exists ...") caused real agents to run
  // `test -e <path>` literally INSTEAD of writing the file, then ack.
  // The fix is to describe the steps in order without using the word
  // "verify" — the agent should just execute the steps.
  if (args.outputAbsolutePath) {
    lines.push(
      `After you save the output file, run this command exactly once to signal you're done:`,
    )
  } else {
    lines.push(`When you're done, run this command exactly once:`)
  }
  lines.push(
    `  curl -sS -X POST ${args.bridgeBaseUrl}/api/sessions/${args.sessionId}/inbox/ack ` +
      `-H 'content-type: application/json' ` +
      `-d '{"eventIds":["${args.inboxEventId}"]}'`,
  )
  if (args.sentinelPath) {
    lines.push(
      `(If you can't run curl, an equivalent signal: create the empty file ${args.sentinelPath} via \`touch '${args.sentinelPath}'\`.)`,
    )
  }
  if (args.outputAbsolutePath) {
    lines.push(
      "The Director reads the output file as soon as it sees your signal — if the file is missing, the run fails.",
    )
  }
  return lines.join("\n")
}

function formatContext(value: unknown, fmt: "json" | "yaml" | "markdown" | "text"): string {
  if (fmt === "text") return String(value)
  if (fmt === "markdown") {
    return typeof value === "string"
      ? value
      : "```\n" + JSON.stringify(value, null, 2) + "\n```"
  }
  // yaml: minimal — for now, just stringify
  if (fmt === "yaml") {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2)
  }
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```"
}

/**
 * Director side of the task. Hands one work item to a live agent
 * session and resolves when the agent has explicitly acked via the
 * bridge inbox API.
 */
export async function invokeAgent<T = unknown>(
  sessionId: string,
  spec: InvokeAgentSpec,
): Promise<InvokeAgentResult<T>> {
  if (!sessionId || typeof sessionId !== "string") {
    throw new WorkflowRuntimeError(
      `invokeAgent: sessionId is required (got ${JSON.stringify(sessionId)})`,
      "bad_args",
    )
  }
  const endpoint = resolveBridge(spec.bridge)
  const ctx: RuntimeContext = getRuntimeContext()
  const taskId = spec.taskId ?? nextTaskId()
  const timeoutMs = spec.timeoutMs ?? 600_000
  const pollMs = spec.pollIntervalMs ?? 250

  // Resolve the output file path (relative → absolute), if any.
  let outputAbsolutePath: string | undefined
  let outputFormat: string | undefined
  if (spec.outputFile) {
    const resolution = spec.outputFileResolution ?? "workspace"
    outputAbsolutePath = resolveOutputPath(spec.outputFile, resolution, ctx)
    outputFormat = spec.format ?? (outputAbsolutePath.endsWith(".json") ? "json" : "text")
    // Pre-create the parent directory so the agent's write doesn't
    // fail with ENOENT-on-mkdir. Some agents handle mkdir themselves;
    // some don't. Either way, having the dir already there removes
    // one possible failure mode.
    try {
      await fs.mkdir(path.dirname(outputAbsolutePath), { recursive: true })
    } catch {}
  }

  console.log(
    `[invokeAgent] → ${sessionId} task=${taskId}${spec.outputFile ? ` outputFile=${spec.outputFile}` : ""}`,
  )
  const t0 = Date.now()

  // 1. Push a workflow_task event into the agent's inbox. The event.id
  //    we get back is the ack key the agent must POST to /inbox/ack.
  const pushRes = await bridgeFetch(endpoint, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/inbox`, {
    kind: "workflow_task",
    payload: {
      taskId,
      body: spec.body,
      outputFile: outputAbsolutePath ?? null,
      format: outputFormat ?? null,
    },
  })
  const pushed = await asJson<InboxPushResponse>(pushRes, "inbox push")
  if (pushed.ok === false) {
    // Bridge returned 200 OK at the HTTP layer but {ok:false} in the
    // body — happens e.g. when the kind isn't in EVENT_KINDS (real
    // bridge does HTTP 400 for that; this branch covers 200+ok:false
    // protocols some endpoints use). Surface bridge's error verbatim.
    throw new WorkflowRuntimeError(
      `invokeAgent: bridge rejected /inbox push: ${pushed.error ?? "(no error message)"}`,
      "bridge_rejected_push",
      { sessionId, pushed },
    )
  }
  const inboxEventId = pushed.event?.id
  if (!inboxEventId) {
    throw new WorkflowRuntimeError(
      `invokeAgent: bridge returned no event.id from /inbox push (${JSON.stringify(pushed).slice(0, 200)})`,
      "bridge_protocol",
      { sessionId, pushed },
    )
  }

  // 2. Drop the prompt + ack instruction into the agent's PTY.
  // If /input fails we want to fail fast — without the prompt, the
  // agent has nothing to act on, and a silent failure here would
  // surface as a misleading `ack_timeout` minutes later.
  // Sentinel file is offered as a fallback handoff option when we
  // know a runDir — agents without curl access (or that find file
  // writes simpler) can `touch` it instead of running the API call.
  // Either signal counts as "done."
  const sentinelPath = ctx.runDir
    ? path.join(ctx.runDir, "handoffs", `${inboxEventId}.done`)
    : undefined
  if (sentinelPath) {
    try {
      await fs.mkdir(path.dirname(sentinelPath), { recursive: true })
    } catch {}
  }
  const prompt = buildPromptForAgent({
    sessionId,
    body: spec.body,
    inboxEventId,
    outputAbsolutePath,
    outputFormat,
    context: spec.context,
    contextFormat: spec.contextFormat,
    bridgeBaseUrl: endpoint.baseUrl.replace(/\/$/, ""),
    sentinelPath,
  })
  const inputRes = await bridgeFetch(
    endpoint,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/input`,
    { data: prompt, submit: true, from: "workflow-runtime" },
  )
  if (!inputRes.ok) {
    let bodyText = ""
    try { bodyText = await inputRes.text() } catch {}
    throw new WorkflowRuntimeError(
      `invokeAgent: failed to deliver prompt via /input (HTTP ${inputRes.status}): ${bodyText.slice(0, 200)}`,
      "prompt_delivery_failed",
      { sessionId, status: inputRes.status, inboxEventId },
    )
  }

  // 3. Long-poll inbox for ack on this event. Also watch the ticket
  // status (if we have one): an agent that self-closes the ticket
  // strands invokeAgent on its inbox poll until ack_timeout, which is
  // bad UX. By looking up the ticket via the runtime's openTickets
  // registry (any registered ticket on this same session counts), we
  // can fail-fast with `ticket_closed` when the ticket goes done /
  // cancelled while we're waiting.
  const owningTicketId = findOwningTicketIdForSession(ctx, sessionId)
  const ackedEvent = await waitForInboxAck(
    endpoint,
    sessionId,
    inboxEventId,
    pollMs,
    timeoutMs,
    owningTicketId,
    sentinelPath,
  )
  const durationMs = Date.now() - t0
  console.log(`[invokeAgent] ← ${sessionId} task=${taskId} acked in ${(durationMs / 1000).toFixed(1)}s`)

  // 4. If an output file was declared, read it back as the task's reply.
  let reply: T | undefined
  if (outputAbsolutePath) {
    try {
      const fmt = detectFormat(outputAbsolutePath, spec.format)
      reply = (await readByFormat(outputAbsolutePath, fmt)) as T
    } catch (e) {
      // The ack arrived but the file isn't readable — agent acked
      // without writing. Fetch session state so the error carries the
      // agent's last visible output, useful for diagnosing what the
      // agent thought it was doing instead of writing the file.
      let diagnostic: Record<string, unknown> | undefined
      try {
        const sRes = await bridgeFetch(
          endpoint,
          "GET",
          `/api/sessions/${encodeURIComponent(sessionId)}`,
        )
        if (sRes.ok) {
          const sBody = (await sRes.json()) as
            | { session?: { state?: string; facts?: Record<string, unknown> } }
            | { state?: string; facts?: Record<string, unknown> }
          const wrapped = (sBody as { session?: unknown }).session
          const flat = (wrapped ?? sBody) as { state?: string; facts?: Record<string, unknown> }
          diagnostic = {
            state: flat.state,
            lastOutput: typeof flat.facts?.lastOutput === "string" ? flat.facts.lastOutput.slice(0, 400) : "",
          }
        }
      } catch {}
      throw new WorkflowRuntimeError(
        `invokeAgent: task ${taskId} acked but output file unreadable at ${outputAbsolutePath}: ${(e as Error).message}${
          diagnostic ? ` (agent's last output: ${JSON.stringify(diagnostic.lastOutput).slice(0, 200)})` : ""
        }`,
        "missing_output",
        { taskId, inboxEventId, outputAbsolutePath, diagnostic },
      )
    }
  }

  return {
    reply,
    outputFile: outputAbsolutePath,
    taskId,
    inboxEventId,
    ackedAt: ackedEvent.ackedAt ?? new Date().toISOString(),
    durationMs,
  }
}

async function waitForInboxAck(
  endpoint: BridgeEndpoint,
  sessionId: string,
  inboxEventId: string,
  pollMs: number,
  totalBudgetMs: number,
  watchTicketId?: string,
  sentinelPath?: string,
): Promise<InboxEvent> {
  const deadline = Date.now() + totalBudgetMs
  // Be tolerant of transient 5xx (bridge restart, hiccup) up to N
  // consecutive misses — after that, fail fast with bridge_unreachable
  // instead of riding out the full ack_timeout. 404s on the session id
  // mean the session is gone (closed, terminated, crashed) and there's
  // no point continuing — fail immediately. If a `watchTicketId` was
  // provided, also probe its status on each tick: when the agent
  // self-closes the ticket (calls /api/tickets/:id/complete) the
  // ticket goes to done/cancelled — we fail immediately with
  // ticket_closed rather than waiting out the full timeout.
  const MAX_CONSECUTIVE_5XX = 5
  let consecutive5xx = 0
  // Throttle ticket-status checks: don't fire one every pollMs (cheap
  // but not free) — every ~1s is enough for "did the agent self-close?"
  const TICKET_CHECK_INTERVAL_MS = 1000
  let lastTicketCheckAt = 0
  while (Date.now() < deadline) {
    const res = await bridgeFetch(
      endpoint,
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/inbox?includeAcked=true`,
    )
    if (res.ok) {
      consecutive5xx = 0
      const body = (await res.json()) as InboxListResponse
      const match = body.events?.find((e) => e.id === inboxEventId)
      if (match?.ackedAt) {
        return match
      }
    } else if (res.status === 404) {
      throw new WorkflowRuntimeError(
        `invokeAgent: session ${sessionId} disappeared mid-wait (bridge 404)`,
        "session_gone",
        { sessionId, inboxEventId },
      )
    } else if (res.status >= 500) {
      consecutive5xx += 1
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        let bodyText = ""
        try { bodyText = await res.text() } catch {}
        throw new WorkflowRuntimeError(
          `invokeAgent: bridge unreachable (${consecutive5xx} consecutive ${res.status}s) :: ${bodyText.slice(0, 200)}`,
          "bridge_unreachable",
          { sessionId, inboxEventId, status: res.status },
        )
      }
    }
    // Any other non-ok (e.g. 400) — swallow and retry; deadline will
    // still cap the wait if something's pathologically wrong.

    // Sentinel-file fallback: agent may have signalled via `touch`
    // instead of the API curl. If we find the file, we ack the inbox
    // event ourselves so the bookkeeping stays consistent, then
    // return as if the agent had acked normally. Fast enough to check
    // every loop tick — single stat call, ENOENT in the common case.
    if (sentinelPath) {
      try {
        await fs.stat(sentinelPath)
        // File exists. Auto-ack the inbox event so the bridge sees a
        // matching ackedAt — pretends the agent did the canonical
        // path. Best-effort: if the ack POST fails we still return
        // success because the agent's signal was the source of truth.
        try {
          await bridgeFetch(
            endpoint,
            "POST",
            `/api/sessions/${encodeURIComponent(sessionId)}/inbox/ack`,
            { eventIds: [inboxEventId] },
          )
        } catch {}
        // Look up the event one more time so we return a real
        // InboxEvent shape (with the ackedAt the bridge just set).
        const refreshRes = await bridgeFetch(
          endpoint,
          "GET",
          `/api/sessions/${encodeURIComponent(sessionId)}/inbox?includeAcked=true`,
        )
        if (refreshRes.ok) {
          const refreshBody = (await refreshRes.json()) as InboxListResponse
          const refreshed = refreshBody.events?.find((e) => e.id === inboxEventId)
          if (refreshed) return refreshed
        }
        // Fallback: synthesize a minimal event record so the caller
        // doesn't need to handle "sentinel-acked but no record"
        // separately.
        return {
          id: inboxEventId,
          kind: "workflow_task",
          payload: {},
          createdAt: new Date().toISOString(),
          ackedAt: new Date().toISOString(),
        }
      } catch {
        // ENOENT → no sentinel yet, keep polling
      }
    }

    // Throttled ticket-status check.
    if (watchTicketId && Date.now() - lastTicketCheckAt >= TICKET_CHECK_INTERVAL_MS) {
      lastTicketCheckAt = Date.now()
      const tRes = await bridgeFetch(
        endpoint,
        "GET",
        `/api/tickets/${encodeURIComponent(watchTicketId)}`,
      )
      if (tRes.ok) {
        try {
          const tBody = (await tRes.json()) as { ticket?: { status?: string } }
          const status = String(tBody.ticket?.status ?? "").toLowerCase()
          if (status && status !== "open" && status !== "in_progress") {
            throw new WorkflowRuntimeError(
              `invokeAgent: ticket ${watchTicketId} closed (status=${status}) before ack — agent likely self-closed mid-task`,
              "ticket_closed",
              { sessionId, inboxEventId, ticketId: watchTicketId, ticketStatus: status },
            )
          }
        } catch (e) {
          // Rethrow our own; tolerate parse hiccups otherwise.
          if (e instanceof WorkflowRuntimeError) throw e
        }
      }
    }

    await sleep(pollMs)
  }
  // Ack timeout — fetch session state once for diagnostics so the
  // caller can see what the agent actually said. Cheap and only fires
  // on the failure path.
  let diagnostic: Record<string, unknown> | undefined
  try {
    const sRes = await bridgeFetch(
      endpoint,
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    )
    if (sRes.ok) {
      const sBody = (await sRes.json()) as
        | { session?: { state?: string; facts?: Record<string, unknown> } }
        | { state?: string; facts?: Record<string, unknown> }
      const wrapped = (sBody as { session?: unknown }).session
      const flat = (wrapped ?? sBody) as { state?: string; facts?: Record<string, unknown> }
      diagnostic = {
        state: flat.state,
        lastInput: typeof flat.facts?.lastInput === "string" ? flat.facts.lastInput.slice(0, 240) : "",
        lastOutput: typeof flat.facts?.lastOutput === "string" ? flat.facts.lastOutput.slice(0, 240) : "",
      }
    }
  } catch {}
  throw new WorkflowRuntimeError(
    `invokeAgent: ack for event ${inboxEventId} never arrived within ${totalBudgetMs}ms${
      diagnostic ? ` (last session state: ${diagnostic.state}, last output: ${JSON.stringify(diagnostic.lastOutput).slice(0, 160)})` : ""
    }`,
    "ack_timeout",
    { sessionId, inboxEventId, diagnostic },
  )
}

/**
 * Find the ticketId on the runtime context's openTickets registry
 * that owns the given sessionId. Used by waitForInboxAck to detect
 * when the agent self-closes their ticket mid-task.
 */
function findOwningTicketIdForSession(
  ctx: RuntimeContext,
  sessionId: string,
): string | undefined {
  const open = ctx.openTickets
  if (!open) return undefined
  for (const handle of open.values()) {
    if (handle.sessionId === sessionId) return handle.ticketId
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
