// ask(): the workhorse primitive. Sends a prompt to a PTY session, waits for
// completion, returns the reply. Two completion modes:
//
//   1. file mode (preferred, set options.outputFile): we augment the prompt
//      with an [OUTPUT INSTRUCTION] line declaring the file the agent should
//      write. We then wait for that file to settle and parse it.
//
//   2. PTY-extract mode (fallback): we wait for the session to leave
//      "thinking"/"tool_running" and back into waiting_input/waiting_advance,
//      then extract reply via options.extract (default "lastOutput").
//
// File mode is always more reliable when the agent can use a Write tool —
// terminal control codes, line wrap, and ambient prompt formatting can all
// corrupt PTY-scrape output.

import path from "path"
import {
  getSessionState,
  resolveBridge,
  sendInput,
  waitForSessionState,
} from "./bridge.ts"
import {
  detectFormat,
  readByFormat,
  resolveOutputPath,
  waitForFile,
} from "./files.ts"
import {
  type AskOptions,
  type AskResult,
  type AskTarget,
  type RuntimeContext,
  type SessionState,
  type SessionStateName,
  WorkflowRuntimeError,
} from "./types.ts"

let runtimeContext: RuntimeContext | null = null

/**
 * Set process-wide runtime context. Workflows usually call this once at
 * top of file (or via a generated header line); per-call options can still
 * override workspaceId / contentRoot.
 */
export function setRuntimeContext(ctx: Partial<RuntimeContext>): void {
  if (!runtimeContext) {
    runtimeContext = {
      contentRoot: ctx.contentRoot ?? process.cwd(),
      defaultBridge: ctx.defaultBridge ?? {
        baseUrl: process.env.WORKFLOW_BRIDGE_URL || "http://127.0.0.1:3210",
      },
      workspaceId: ctx.workspaceId,
      runDir: ctx.runDir,
    }
  } else {
    runtimeContext = {
      ...runtimeContext,
      ...ctx,
      defaultBridge: { ...runtimeContext.defaultBridge, ...(ctx.defaultBridge ?? {}) },
    }
  }
}

export function getRuntimeContext(): RuntimeContext {
  if (!runtimeContext) {
    runtimeContext = {
      contentRoot: process.cwd(),
      defaultBridge: {
        baseUrl: process.env.WORKFLOW_BRIDGE_URL || "http://127.0.0.1:3210",
      },
    }
  }
  return runtimeContext
}

// Default expected states the runtime treats as "agent finished".
const DEFAULT_EXPECT_STATES: SessionStateName[] = ["waiting_input", "waiting_advance"]

function targetSpec(target: AskTarget) {
  if (typeof target === "string") return { sessionId: target, bridge: undefined }
  return target
}

function buildContextBlock(value: unknown, format: NonNullable<AskOptions["contextFormat"]> = "json"): string {
  if (format === "text") return String(value)
  if (format === "markdown") {
    return typeof value === "string" ? value : "```\n" + JSON.stringify(value, null, 2) + "\n```"
  }
  if (format === "yaml") {
    // Minimal YAML emitter: only objects/arrays/primitives. Adequate for the
    // common case; users with richer needs can pre-stringify themselves.
    return toYaml(value, 0)
  }
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```"
}

function toYaml(value: unknown, indent: number): string {
  const pad = " ".repeat(indent)
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value.map((v) => `${pad}- ${toYaml(v, indent + 2)}`).join("\n")
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    return entries
      .map(([k, v]) => {
        const child = toYaml(v, indent + 2)
        if (child.includes("\n")) return `${pad}${k}:\n${child}`
        return `${pad}${k}: ${child}`
      })
      .join("\n")
  }
  return JSON.stringify(value)
}

function buildOutputInstruction(absolutePath: string, format: AskOptions["format"]): string {
  // Tight phrasing — every token here is paid on every ask. The agent
  // only needs three things: where, format, and a stop signal.
  const fmt = format ?? (absolutePath.endsWith(".json") ? "json" : "text")
  const tail = fmt === "json"
    ? "JSON only, no fences."
    : fmt === "markdown"
      ? "Markdown body only."
      : "Plain text only."
  return `\n[OUTPUT]\nWrite to ${absolutePath} as ${fmt}. ${tail} Then finish your turn.`
}

function pickReplyFromState(state: SessionState, mode: NonNullable<AskOptions["extract"]>): string {
  if (typeof mode === "function") return mode(state)
  if (mode === "lastOutput") {
    return String(state.facts?.lastOutput ?? "").trim()
  }
  if (mode === "screen") {
    const screen = (state as { screen?: string; facts?: { screen?: string } }).screen
      ?? state.facts?.screen
    return String(screen ?? "").trim()
  }
  if (mode === "timelineDelta") {
    // Bridge versions vary; we look in a few likely places.
    const timeline = (state as { timeline?: unknown[] }).timeline
    if (Array.isArray(timeline)) return timeline.map((entry) => JSON.stringify(entry)).join("\n")
    return String(state.facts?.lastOutput ?? "").trim()
  }
  return String(state.facts?.lastOutput ?? "").trim()
}

export async function ask<T = unknown>(
  target: AskTarget,
  prompt: string,
  opts: AskOptions = {},
): Promise<AskResult<T>> {
  const { sessionId, bridge } = targetSpec(target)
  // resolveBridge() with no arg returns the bridge module's runtime default
  // (the one setDefaultBridge updates). When the call site pins a bridge via
  // target.bridge, that wins.
  const endpoint = resolveBridge(bridge)
  const ctx: RuntimeContext = {
    contentRoot: opts.contentRoot ?? getRuntimeContext().contentRoot,
    defaultBridge: getRuntimeContext().defaultBridge,
    workspaceId: opts.workspaceId ?? getRuntimeContext().workspaceId,
  }
  const startedAt = Date.now()
  // Progress log: one line at entry, one at exit. The browser tails
  // stdout.log so per-ask timings are visible while the run is in
  // flight (each ask can take 5-60s for real LLMs).
  console.log(`[ask] → ${sessionId} (${prompt.length} chars prompt)`)
  const expectStates = opts.expectStates ?? DEFAULT_EXPECT_STATES

  // Pre-flight
  if (opts.preflight === "require_idle") {
    const cur = await getSessionState(endpoint, sessionId)
    if (!expectStates.includes(cur.state)) {
      throw new WorkflowRuntimeError(
        `session ${sessionId} not idle (state=${cur.state})`,
        "preflight_failed",
        { state: cur },
      )
    }
  } else if (opts.preflight === "force_interrupt") {
    const cur = await getSessionState(endpoint, sessionId)
    if (!expectStates.includes(cur.state)) {
      // Best-effort interrupt; bridge may or may not have the endpoint.
      try {
        await sendInput(endpoint, sessionId, "", { submit: false })
      } catch {}
      await waitForSessionState(endpoint, sessionId, {
        expect: expectStates,
        timeoutMs: 30_000,
      })
    }
  }

  // Resolve outputFile (if any)
  let absoluteOutputPath: string | undefined
  let preCallMtime = 0
  if (opts.outputFile) {
    const resolution = opts.outputFileResolution ?? "workspace"
    absoluteOutputPath = resolveOutputPath(opts.outputFile, resolution, ctx)
    // Capture pre-call mtime so requireUpdate can detect a fresh write.
    try {
      const stat = await import("fs/promises").then((m) => m.stat(absoluteOutputPath!))
      preCallMtime = stat.mtimeMs
    } catch {
      preCallMtime = 0
    }
  }

  // Compose the prompt
  const promptParts: string[] = [prompt]
  if (opts.context !== undefined) {
    promptParts.push("")
    promptParts.push("[CONTEXT]")
    promptParts.push(buildContextBlock(opts.context, opts.contextFormat))
  }
  if (absoluteOutputPath) {
    promptParts.push(
      buildOutputInstruction(
        opts.echoAbsolutePath === false
          ? path.relative(ctx.contentRoot, absoluteOutputPath)
          : absoluteOutputPath,
        opts.format,
      ),
    )
  }
  const fullPrompt = promptParts.join("\n")

  // Send prompt with retry
  const retry = opts.retry ?? { count: 0 }
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retry.count; attempt++) {
    try {
      await sendInput(endpoint, sessionId, fullPrompt, {
        submit: opts.submit !== false,
        from: "workflow-runtime",
      })
      lastError = null
      break
    } catch (e) {
      lastError = e as Error
      if (attempt < retry.count && (retry.on?.(lastError) ?? true)) {
        await new Promise((r) => setTimeout(r, retry.backoffMs ?? 1000))
        continue
      }
      throw lastError
    }
  }
  if (lastError) throw lastError

  const sentAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 600_000

  // Wait for completion
  let finalState: SessionState
  if (absoluteOutputPath) {
    // File mode: wait for both the file to settle AND the session to land
    // back in an expected state. Run them in parallel and require both.
    const [, state] = await Promise.all([
      waitForFile(absoluteOutputPath, {
        timeoutMs,
        mtimeFloor: preCallMtime,
        requireUpdate: preCallMtime > 0,
        abort: opts.abort,
      }),
      waitForSessionState(endpoint, sessionId, {
        expect: expectStates,
        timeoutMs,
        notBefore: sentAt + 200, // small grace so we don't return the pre-send state
        intervalMs: opts.poll?.intervalMs,
        abort: opts.abort,
      }),
    ])
    finalState = state
  } else {
    finalState = await waitForSessionState(endpoint, sessionId, {
      expect: expectStates,
      timeoutMs,
      notBefore: sentAt + 200,
      intervalMs: opts.poll?.intervalMs,
      abort: opts.abort,
    })
  }

  // Build reply
  let reply: unknown
  if (absoluteOutputPath) {
    const format = detectFormat(absoluteOutputPath, opts.format)
    reply = await readByFormat(absoluteOutputPath, format)
  } else {
    reply = pickReplyFromState(finalState, opts.extract ?? "lastOutput")
  }

  const durationMs = Date.now() - startedAt
  console.log(`[ask] ← ${sessionId} (state=${finalState.state}, ${(durationMs / 1000).toFixed(1)}s)`)
  return {
    reply: reply as T,
    state: finalState.state,
    durationMs,
    raw: finalState,
    outputFile: absoluteOutputPath,
  }
}
