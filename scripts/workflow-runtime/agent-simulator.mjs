// Weighted-random agent simulator for stress-testing the shell. Each
// behavior models a real-world failure mode invokeAgent has to survive:
//
//   normal       — completes within budget, acks, writes file
//   slow         — waits a bounded time then acks normally
//   hang         — never acks (forces ack_timeout)
//   crash        — handler throws mid-run (no file, no ack)
//   partial      — acks without writing the declared output file
//   wrong_format — writes invalid JSON to a json-format output
//   close        — kills its own session mid-task (forces session_gone)
//
// The simulator records, per session, which behavior fired and when.
// A test can then call agentSimulator.report() to assert distribution
// (every requested behavior actually fired N times) and that each
// behavior produced the expected invokeAgent outcome.

import { promises as fs } from "fs"

/**
 * @typedef {"normal"|"slow"|"hang"|"crash"|"partial"|"wrong_format"|"close"} BehaviorKind
 */

/**
 * @typedef {Object} BehaviorConfig
 * @property {number} weight        — relative probability share
 * @property {(rnd: () => number) => number} [delayMs] — optional ms to wait before responding
 */

const DEFAULT_BEHAVIORS = {
  normal:       { weight: 5 },
  slow:         { weight: 2 },
  hang:         { weight: 1 },
  crash:        { weight: 1 },
  partial:      { weight: 1 },
  wrong_format: { weight: 1 },
  close:        { weight: 1 },
}

/**
 * Seeded PRNG so a failing stress test reproduces. xorshift32 is
 * adequate for behaviour-distribution work; we don't need crypto.
 */
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build the simulator. The `bridge` is a createMockBridge instance.
 *
 * @param {object} bridge
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {Partial<Record<BehaviorKind, BehaviorConfig>>} [opts.behaviors]
 */
export function createAgentSimulator(bridge, opts = {}) {
  const rnd = mulberry32(opts.seed ?? 42)
  const behaviors = { ...DEFAULT_BEHAVIORS, ...(opts.behaviors ?? {}) }
  /** @type {Array<{ sessionId: string; behavior: BehaviorKind; at: number }>} */
  const log = []

  const totalWeight = Object.values(behaviors).reduce((s, b) => s + b.weight, 0)
  function pickBehavior() {
    let r = rnd() * totalWeight
    for (const [k, v] of Object.entries(behaviors)) {
      if (r < v.weight) return k
      r -= v.weight
    }
    return "normal"
  }

  /** Per-session forced behavior — when set, pickBehavior is bypassed. */
  const forcedBySession = new Map()

  function attach(sessionId, opts = {}) {
    if (opts.force) forcedBySession.set(sessionId, opts.force)
    bridge.ensureSession(sessionId)
    bridge.setAgent(sessionId, async ({ outputFile, format }) => {
      const behavior = forcedBySession.get(sessionId) ?? pickBehavior()
      log.push({ sessionId, behavior, at: Date.now() })
      switch (behavior) {
        case "hang":
          // Block forever (test framework's outer timeout will reap).
          // Use __skipHandoffAck so the mock doesn't auto-ack the event.
          await new Promise(() => {}) // never resolves
          return { reply: { __skipHandoffAck: true } } // unreachable
        case "crash":
          throw new Error("[agent-simulator] crash")
        case "slow": {
          await new Promise((r) => setTimeout(r, 80 + Math.floor(rnd() * 60)))
          return { reply: { ok: true, behavior } }
        }
        case "partial": {
          // ACK happens (auto), but we do NOT supply `reply` so the
          // file is never written → missing_output if outputFile set.
          return { lastOutput: "partial done", reply: undefined }
        }
        case "wrong_format": {
          if (outputFile && format === "json") {
            // Write garbage that won't JSON.parse.
            try {
              await fs.mkdir(outputFile.replace(/\/[^/]+$/, ""), { recursive: true })
              await fs.writeFile(outputFile, "not valid json {{{", "utf8")
            } catch {}
          }
          return { lastOutput: "wrong format written", reply: undefined }
        }
        case "close": {
          // Simulate the session disappearing mid-task. We schedule the
          // kill slightly after the auto-ack timing so invokeAgent's
          // poll sees the kill before resolution.
          setTimeout(() => bridge.killSession(sessionId), 30)
          return { reply: { __skipHandoffAck: true } }
        }
        case "normal":
        default:
          return { reply: { ok: true, behavior } }
      }
    })
  }

  return {
    attach,
    log,
    report() {
      const tally = {}
      for (const entry of log) tally[entry.behavior] = (tally[entry.behavior] || 0) + 1
      return tally
    },
  }
}

/**
 * Map a behavior to the invokeAgent outcome we expect to see. Tests
 * use this to assert that every fired behavior produced the right
 * resolution shape (success) or error code (failure).
 *
 * Notes:
 *   - `partial` only errors if the test set `outputFile`; otherwise
 *     it succeeds (no file expected).
 *   - `wrong_format` writes invalid JSON → readByFormat throws inside
 *     invokeAgent which converts to `missing_output` per current code.
 *     If we change that to a separate `bad_format` later, update here.
 */
export function expectedOutcomeFor(behavior, opts = {}) {
  const hasOutput = !!opts.outputFile
  switch (behavior) {
    case "normal":
    case "slow":
      return { kind: "success" }
    case "hang":
      return { kind: "error", code: "ack_timeout" }
    case "crash":
      // Mock catches the handler throw, marks lastOutput as error,
      // session stays in waiting_input WITHOUT acking → ack_timeout.
      return { kind: "error", code: "ack_timeout" }
    case "partial":
      return hasOutput
        ? { kind: "error", code: "missing_output" }
        : { kind: "success" }
    case "wrong_format":
      // The mock writes garbage to the json file; invokeAgent's
      // readByFormat throws JSON-parse, which surfaces as missing_output
      // (the error message will mention "not valid JSON"). If we add a
      // separate bad_format code later this should update.
      return hasOutput
        ? { kind: "error", code: "missing_output" }
        : { kind: "success" }
    case "close":
      return { kind: "error", code: "session_gone" }
    default:
      return { kind: "success" }
  }
}
