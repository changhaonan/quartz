// Mock claude_pty bridge for runtime testing. Emulates the session API so we
// can drive the workflow runtime without a real PTY. Behavior per session is
// configurable: when input arrives, a registered "agent" callback runs (with
// optional delay) and decides what to write to which file. The mock then
// transitions the session back to waiting_input so ask() returns.

import { createServer } from "http"
import { promises as fs } from "fs"

export function createMockBridge() {
  /** @type {Map<string, MockSession>} */
  const sessions = new Map()
  /** @type {Map<string, AgentHandler>} */
  const agents = new Map()
  /** @type {Array<{ sessionId: string; prompt: string; at: number }>} */
  const log = []
  // Role-keyed registrations used by the ticket endpoints. When a ticket
  // for role X gets filed and no live session is currently bound to X,
  // we auto-spawn one and wire its agent handler from this map. Mirrors
  // bridge's auto_spawn semantics narrowly enough for client tests.
  /** @type {Map<string, AgentHandler>} */
  const roleAgents = new Map()
  /** @type {Map<string, MockTicket>} */
  const tickets = new Map()
  // Per-session inbox event store keyed by sessionId → array of events.
  // Each event has { id, kind, payload, createdAt, ackedAt }. The real
  // bridge persists these to disk; the mock keeps them in memory.
  /** @type {Map<string, Array<MockInboxEvent>>} */
  const inboxes = new Map()
  let nextInboxEventCounter = 1
  /**
   * Fault-injection knobs for stress / failure-mode tests. The mock
   * intercepts the inbox endpoints and behaves per these settings.
   */
  const faults = {
    /** Number of /inbox GETs that should return 500 before normal behaviour resumes. */
    inboxListFiveHundredCount: 0,
    /** Session ids that should always 404 on GET /inbox (simulates death). */
    deadSessions: new Set(),
    /** Status to return on next N /inbox POST calls (push). 0 = pass through. */
    inboxPushStatus: 0,
    inboxPushStatusCount: 0,
    inboxPushStatusBody: null, // override response body for the failing pushes
    /** Status to return on next N /input POST calls. 0 = pass through. */
    inputStatus: 0,
    inputStatusCount: 0,
    /** If true, next push returns 201 + a body that's missing the event.id field. */
    inboxPushMalformed: false,
  }
  /**
   * @typedef {Object} MockInboxEvent
   * @property {string} id
   * @property {string} kind
   * @property {Record<string, unknown>} payload
   * @property {string} createdAt
   * @property {string | null} ackedAt
   */
  /**
   * @typedef {Object} MockTicket
   * @property {string} id
   * @property {string} status   // open | complete | cancelled
   * @property {string} assigneeRoleId
   * @property {string} assigneeSessionId
   * @property {string} summary
   * @property {Array<{ kind: string; sessionId?: string }>} events
   */

  /**
   * @typedef {Object} MockSession
   * @property {string} sessionId
   * @property {string} state
   * @property {{ lastOutput: string; lastInput: string; }} facts
   * @property {string} screen
   */

  /**
   * @typedef {(args: { sessionId: string; prompt: string; outputFile: string | null; format: string }) => Promise<{ reply?: string; lastOutput?: string }> | { reply?: string; lastOutput?: string }} AgentHandler
   */

  function ensureSession(sessionId) {
    let s = sessions.get(sessionId)
    if (!s) {
      s = {
        sessionId,
        state: "waiting_input",
        facts: { lastOutput: "", lastInput: "" },
        screen: "",
      }
      sessions.set(sessionId, s)
    }
    return s
  }

  function parseHandoffEventId(prompt) {
    // invokeAgent appends:
    //   [HANDOFF]
    //   When done, run …/inbox/ack -d '{"eventIds":["<eventId>"]}'
    // Pull the eventId out so the mock can auto-ack after the agent
    // handler returns. Looser regex than strictly necessary so future
    // tweaks to the prompt shape don't immediately break the mock.
    const m = prompt.match(/eventIds["']?\s*:\s*\[\s*["']([^"']+)["']/)
    return m ? m[1] : null
  }

  function parseOutputInstruction(prompt) {
    // Tracks ask.ts's buildOutputInstruction. Current shape is:
    //   [OUTPUT]\nWrite to <path> as <fmt>. <tail> Then finish your turn.
    // The old shape "Write your final answer to: <path>\nFormat: <fmt>."
    // is also accepted so this mock works against either runtime version
    // during transitions. Path capture must be greedy on \S so we don't
    // clip the extension at a literal "." inside paths like "out.json".
    const m = prompt.match(/Write (?:to|your final answer to:?)\s+(\S+)/)
    if (!m) return { outputFile: null, format: "text" }
    // Strip trailing punctuation the old "Format: …" line did NOT have.
    const outputFile = m[1].replace(/[.,;:]+$/, "")
    const fmtMatch = prompt.match(/(?:Format:\s*|\bas\s+)(json|text|markdown|raw)\b/i)
    const format = (fmtMatch?.[1] ?? "text").toLowerCase()
    return { outputFile, format }
  }

  /** Register an agent for a session. */
  function setAgent(sessionId, handler) {
    agents.set(sessionId, handler)
    ensureSession(sessionId)
  }

  /**
   * Register an auto-spawn handler for a role. When a ticket comes in
   * with `assigneeRoleId === role`, the mock spins up a fresh session
   * bound to this handler and reports the spawn back on the ticket.
   */
  function setRoleAgent(role, handler) {
    roleAgents.set(role, handler)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
        } catch (e) {
          reject(e)
        }
      })
      req.on("error", reject)
    })
  }

  function sendJson(res, status, payload) {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(payload))
  }

  const server = createServer(async (req, res) => {
    try {
      const { url = "/", method = "GET" } = req
      const urlPath = url.split("?")[0]

      // GET /api/health
      if (method === "GET" && urlPath === "/api/health") {
        return sendJson(res, 200, { ok: true, port: 0, sessions: [] })
      }

      // GET /api/sessions/:id
      const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)$/)
      if (method === "GET" && sessionMatch) {
        const sid = decodeURIComponent(sessionMatch[1])
        const s = sessions.get(sid)
        if (!s) return sendJson(res, 404, { ok: false, error: "no such session" })
        return sendJson(res, 200, s)
      }

      // POST /api/sessions/:id/input
      const inputMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/input$/)
      if (method === "POST" && inputMatch) {
        const sid = decodeURIComponent(inputMatch[1])
        const body = await readBody(req)
        const prompt = String(body.data ?? "")
        const s = ensureSession(sid)
        if (faults.inputStatusCount > 0 && faults.inputStatus > 0) {
          faults.inputStatusCount -= 1
          return sendJson(res, faults.inputStatus, {
            ok: false,
            error: `mock-bridge: injected /input ${faults.inputStatus}`,
          })
        }
        log.push({ sessionId: sid, prompt, at: Date.now() })
        // Mark thinking, then dispatch to the agent.
        s.state = "thinking"
        s.facts.lastInput = prompt.slice(0, 200)
        const agent = agents.get(sid)
        if (!agent) {
          // No agent registered: just echo back as lastOutput and settle.
          s.facts.lastOutput = `[no agent for ${sid}] ${prompt.slice(0, 80)}`
          s.state = "waiting_input"
          return sendJson(res, 200, { ok: true })
        }
        // Run the agent asynchronously so the input POST returns immediately
        // (mirroring real bridge semantics).
        ;(async () => {
          const { outputFile, format } = parseOutputInstruction(prompt)
          let reply // intentionally undefined when agent doesn't supply one
          let lastOutput
          let handlerThrew = false
          try {
            const out = await agent({ sessionId: sid, prompt, outputFile, format })
            if (out && Object.prototype.hasOwnProperty.call(out, "reply")) {
              reply = out.reply
            }
            lastOutput =
              out?.lastOutput ??
              (reply === undefined
                ? ""
                : typeof reply === "string"
                  ? reply
                  : JSON.stringify(reply))
          } catch (e) {
            handlerThrew = true
            lastOutput = `[agent error] ${e.message}`
          }
          // Only write the output file when the agent explicitly asked for
          // it via { reply: ... }. Otherwise leave whatever the agent itself
          // wrote (or didn't write) alone — the runtime's waitForFile +
          // bad_json handling exercises both paths.
          if (outputFile && reply !== undefined) {
            try {
              const dir = outputFile.replace(/\/[^/]+$/, "")
              await fs.mkdir(dir, { recursive: true })
              const text = format === "json"
                ? (typeof reply === "string" ? reply : JSON.stringify(reply, null, 2))
                : String(reply)
              const tmp = `${outputFile}.tmp`
              await fs.writeFile(tmp, text, "utf8")
              await fs.rename(tmp, outputFile)
            } catch (e) {
              s.facts.lastOutput = `[mock-bridge file-write error] ${e.message}`
            }
          }
          s.facts.lastOutput = String(lastOutput ?? "").slice(0, 4000)
          s.state = "waiting_input"
          // invokeAgent contract: after the agent finishes, it acks the
          // event the Director pushed into the inbox. We do that here on
          // the agent's behalf so test handlers stay focused on "what
          // does the agent produce" instead of having to also POST to
          // /inbox/ack. Set `__skipHandoffAck: true` on the agent's
          // returned object to opt out (negative tests on ack timeout).
          // A throwing handler is treated like a crashed real agent —
          // it never gets a chance to run the ack curl, so no auto-ack.
          const handoffEventId = parseHandoffEventId(prompt)
          const skipAck = handlerThrew || !!(typeof reply === "object" && reply && reply.__skipHandoffAck)
          if (handoffEventId && !skipAck) {
            const list = inboxes.get(sid) ?? []
            const ev = list.find((e) => e.id === handoffEventId)
            if (ev && !ev.ackedAt) ev.ackedAt = new Date().toISOString()
          }
        })().catch((e) => {
          s.state = "errored"
          s.facts.lastOutput = `[mock-bridge dispatch error] ${e.message}`
        })
        return sendJson(res, 200, { ok: true })
      }

      // POST /api/sessions/:id/submit
      const submitMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/submit$/)
      if (method === "POST" && submitMatch) {
        return sendJson(res, 200, { ok: true })
      }

      // POST /api/sessions/:id/advance — toggle advance mode. Mock
      // doesn't actually fire advance nudges, but tickets.ts calls
      // this to turn it off after acquiring a session, so we accept
      // the request and return ok.
      const advanceMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/advance$/)
      if (method === "POST" && advanceMatch) {
        return sendJson(res, 200, { ok: true, advanceMode: false })
      }

      // POST /api/sessions/:id/inbox — push event, return event w/ id.
      // Real bridge enforces a kind allowlist (EVENT_KINDS); the mock
      // accepts anything by default so tests can probe edge cases.
      // Fault knobs let tests force specific failure modes.
      const inboxPushMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/inbox$/)
      if (method === "POST" && inboxPushMatch) {
        const sid = decodeURIComponent(inboxPushMatch[1])
        ensureSession(sid)
        const body = await readBody(req)
        if (faults.inboxPushStatusCount > 0 && faults.inboxPushStatus > 0) {
          faults.inboxPushStatusCount -= 1
          const status = faults.inboxPushStatus
          const responseBody = faults.inboxPushStatusBody ?? {
            ok: false,
            error: `mock-bridge: injected ${status}`,
          }
          return sendJson(res, status, responseBody)
        }
        if (faults.inboxPushMalformed) {
          faults.inboxPushMalformed = false
          // Push WAS recorded — that mirrors bridge behaviour — but
          // the response body omits event.id so the client should
          // hit its bridge_protocol guard.
          return sendJson(res, 201, { ok: true, event: { kind: body.kind, payload: body.payload } })
        }
        const event = {
          id: `inbox-mock-${nextInboxEventCounter++}-${Math.random().toString(36).slice(2, 6)}`,
          kind: String(body.kind || ""),
          payload: body.payload && typeof body.payload === "object" ? body.payload : {},
          createdAt: new Date().toISOString(),
          ackedAt: null,
        }
        const list = inboxes.get(sid) ?? []
        list.push(event)
        inboxes.set(sid, list)
        return sendJson(res, 201, { ok: true, event })
      }

      // GET /api/sessions/:id/inbox?includeAcked=true
      const inboxListMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/inbox$/)
      if (method === "GET" && inboxListMatch) {
        const sid = decodeURIComponent(inboxListMatch[1])
        // Fault injection: 500-and-decrement, dead-session 404.
        if (faults.inboxListFiveHundredCount > 0) {
          faults.inboxListFiveHundredCount -= 1
          return sendJson(res, 500, { ok: false, error: "mock-bridge: injected 5xx" })
        }
        if (faults.deadSessions.has(sid)) {
          return sendJson(res, 404, { ok: false, error: "no such session" })
        }
        const includeAcked = String(new URL(url, "http://x").searchParams.get("includeAcked") || "")
          .toLowerCase()
        const wantAcked = includeAcked === "1" || includeAcked === "true" || includeAcked === "yes"
        const list = inboxes.get(sid) ?? []
        const events = wantAcked ? list.slice() : list.filter((e) => !e.ackedAt)
        return sendJson(res, 200, { ok: true, events })
      }

      // POST /api/sessions/:id/inbox/ack — mark events acked by id.
      // This is the handoff signal in the invokeAgent protocol: agent
      // acks the event our Director pushed, Director's long-poll sees
      // ackedAt populated and proceeds to the next step.
      const inboxAckMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/inbox\/ack$/)
      if (method === "POST" && inboxAckMatch) {
        const sid = decodeURIComponent(inboxAckMatch[1])
        const body = await readBody(req)
        const ids = Array.isArray(body.eventIds) ? body.eventIds.map(String) : []
        const list = inboxes.get(sid) ?? []
        const now = new Date().toISOString()
        const acked = []
        for (const ev of list) {
          if (ids.includes(ev.id) && !ev.ackedAt) {
            ev.ackedAt = now
            acked.push(ev)
          }
        }
        return sendJson(res, 200, { ok: true, events: acked })
      }

      // POST /api/sessions
      if (method === "POST" && urlPath === "/api/sessions") {
        const body = await readBody(req)
        const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        ensureSession(id)
        return sendJson(res, 200, { sessionId: id, state: "waiting_input", facts: {}, agent: body.agent })
      }

      // POST /api/tickets — file a ticket. Auto-spawn a session if a role
      // handler is registered; otherwise return the ticket with no
      // assignee (mirrors real bridge "no_assignee" delivery status).
      if (method === "POST" && urlPath === "/api/tickets") {
        const body = await readBody(req)
        const role = String(body.assigneeRoleId || body.suggestedAssignee || "").trim()
        const id = `tkt-mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        /** @type {MockTicket} */
        const ticket = {
          id,
          status: "open",
          assigneeRoleId: role,
          assigneeSessionId: "",
          summary: String(body.summary || ""),
          events: [],
        }
        let deliveryStatus = "no_assignee"
        const handler = roleAgents.get(role)
        if (handler) {
          const sid = `mock-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
          const s = ensureSession(sid)
          s.autoSpawnedFor = id
          s.autoSpawned = true
          agents.set(sid, handler)
          ticket.assigneeSessionId = sid
          ticket.events.push({ kind: "auto_spawned", sessionId: sid })
          deliveryStatus = "delivered"
        }
        tickets.set(id, ticket)
        return sendJson(res, 201, {
          ok: true,
          ticket,
          delivery: body.awaitDelivery
            ? { status: deliveryStatus, attempts: 0, ms: 0 }
            : undefined,
        })
      }

      // GET /api/tickets/:id
      const ticketGetMatch = urlPath.match(/^\/api\/tickets\/([^/]+)$/)
      if (method === "GET" && ticketGetMatch) {
        const tid = decodeURIComponent(ticketGetMatch[1])
        const t = tickets.get(tid)
        if (!t) return sendJson(res, 404, { ok: false, error: "no such ticket" })
        return sendJson(res, 200, { ok: true, ticket: t })
      }

      // POST /api/tickets/:id/complete
      const completeMatch = urlPath.match(/^\/api\/tickets\/([^/]+)\/complete$/)
      if (method === "POST" && completeMatch) {
        const tid = decodeURIComponent(completeMatch[1])
        const t = tickets.get(tid)
        if (!t) return sendJson(res, 404, { ok: false, error: "no such ticket" })
        if (t.status !== "open") {
          return sendJson(res, 409, { ok: false, error: `ticket ${tid} is ${t.status}` })
        }
        t.status = "complete"
        // Sweep any sessions scoped to this ticket.
        for (const s of sessions.values()) {
          if (s.autoSpawnedFor === tid) {
            sessions.delete(s.sessionId)
            agents.delete(s.sessionId)
          }
        }
        return sendJson(res, 200, { ok: true, ticket: t })
      }

      // POST /api/tickets/:id/cancel — same sweep behavior as complete.
      const cancelMatch = urlPath.match(/^\/api\/tickets\/([^/]+)\/cancel$/)
      if (method === "POST" && cancelMatch) {
        const tid = decodeURIComponent(cancelMatch[1])
        const t = tickets.get(tid)
        if (!t) return sendJson(res, 404, { ok: false, error: "no such ticket" })
        if (t.status !== "open") {
          return sendJson(res, 409, { ok: false, error: `ticket ${tid} is ${t.status}` })
        }
        t.status = "cancelled"
        for (const s of sessions.values()) {
          if (s.autoSpawnedFor === tid) {
            sessions.delete(s.sessionId)
            agents.delete(s.sessionId)
          }
        }
        return sendJson(res, 200, { ok: true, ticket: t })
      }

      sendJson(res, 404, { ok: false, error: `no such route ${method} ${urlPath}` })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message || e) })
    }
  })

  /**
   * Start the server on an ephemeral port. Returns base URL.
   * @returns {Promise<string>}
   */
  function start() {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address()
        const port = typeof addr === "object" && addr ? addr.port : 0
        resolve(`http://127.0.0.1:${port}`)
      })
    })
  }

  function stop() {
    return new Promise((resolve) => {
      server.close(() => resolve())
      // Also close any keep-alive sockets.
      server.closeAllConnections?.()
    })
  }

  return {
    start,
    stop,
    setAgent,
    setRoleAgent,
    sessions,
    agents,
    roleAgents,
    tickets,
    inboxes,
    faults,
    log,
    ensureSession,
    // Fault-injection helpers (small wrappers so tests don't poke
    // `faults` directly and we keep room to add validation later).
    injectInboxFiveHundred(count) { faults.inboxListFiveHundredCount = Math.max(0, Number(count) | 0) },
    killSession(sid) { faults.deadSessions.add(sid) },
    /** Make the next N /inbox POST calls return `status` (with optional body). */
    injectInboxPushStatus(status, count = 1, body = null) {
      faults.inboxPushStatus = Number(status) | 0
      faults.inboxPushStatusCount = Math.max(0, Number(count) | 0)
      faults.inboxPushStatusBody = body
    },
    /** Next /inbox POST returns 201 but the response body lacks event.id. */
    injectInboxPushMalformed() { faults.inboxPushMalformed = true },
    /** Make the next N /input POSTs return `status`. */
    injectInputStatus(status, count = 1) {
      faults.inputStatus = Number(status) | 0
      faults.inputStatusCount = Math.max(0, Number(count) | 0)
    },
  }
}
