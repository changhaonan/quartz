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

  function parseOutputInstruction(prompt) {
    // Pull the absolute path the runtime appended in [OUTPUT INSTRUCTION].
    const match = prompt.match(/Write your final answer to:\s*(\S+)/)
    if (!match) return { outputFile: null, format: "text" }
    const outputFile = match[1].trim()
    const fmtMatch = prompt.match(/Format:\s*(\w+)/)
    const format = fmtMatch ? fmtMatch[1].toLowerCase() : "text"
    return { outputFile, format }
  }

  /** Register an agent for a session. */
  function setAgent(sessionId, handler) {
    agents.set(sessionId, handler)
    ensureSession(sessionId)
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

      // POST /api/sessions
      if (method === "POST" && urlPath === "/api/sessions") {
        const body = await readBody(req)
        const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        ensureSession(id)
        return sendJson(res, 200, { sessionId: id, state: "waiting_input", facts: {}, agent: body.agent })
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
    sessions,
    agents,
    log,
    ensureSession,
  }
}
