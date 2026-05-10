// Workflow runtime types. The runtime is Node-side: workflows imported into a
// .ts file and run via `tsx workflow.ts` get to call into a real claude_pty
// bridge to drive PTY sessions. The same module also runs in tests against a
// mock bridge.
//
// Design principle (broad surface, narrow defaults): every option that bridge
// supports surfaces here, but every call site can ignore it. Defaults are
// chosen for the common case (file-based handoff, PTY scrape fallback,
// 10-minute timeouts).

// ─── Bridge addressing ─────────────────────────────────────────────────

/**
 * Where a session lives. A bare string is shorthand for
 * `{ sessionId, bridge: "self" }` — the local default bridge at
 * http://127.0.0.1:3210.
 */
export type AskTarget = string | AskTargetSpec

export interface AskTargetSpec {
  sessionId: string
  /**
   * "self" (local default), "peer" (paired bridge), an explicit base URL like
   * "http://127.0.0.1:3001", or a fully-formed BridgeEndpoint object.
   */
  bridge?: BridgeRef
}

export type BridgeRef = "self" | "peer" | string | BridgeEndpoint

export interface BridgeEndpoint {
  baseUrl: string
  authToken?: string
  /** Optional fetch override — useful for mock bridges in tests. */
  fetch?: typeof fetch
}

// ─── Session state mirror ──────────────────────────────────────────────
// Subset of bridge's GET /api/sessions/:id response we actually use. Bridge
// returns more (lifecycle, role, advance, timing, …); the runtime exposes the
// full thing under AskResult.raw for callers that need it.

export type SessionStateName =
  | "uninited"
  | "standby"
  | "starting"
  | "thinking"
  | "tool_running"
  | "waiting_input"
  | "waiting_advance"
  | "exited"
  | "errored"
  | string // forward-compat for bridge adding new state names

export interface SessionState {
  sessionId: string
  state: SessionStateName
  detectorState?: SessionStateName
  inited?: boolean
  hasPty?: boolean
  facts?: {
    lastState?: string
    lastInput?: string
    lastOutput?: string
    lastBridgeMessage?: string
    [key: string]: unknown
  }
  /** Anything else bridge returned. */
  [key: string]: unknown
}

// ─── Ask ───────────────────────────────────────────────────────────────

/**
 * Where a reply comes from when ask completes.
 *   "lastOutput"     facts.lastOutput from the bridge timeline (default)
 *   "screen"         the rendered PTY screen at completion
 *   "timelineDelta"  everything since the input was sent
 *   (function)       custom selector against the full SessionState
 *
 * Ignored when AskOptions.outputFile is set — file content always wins.
 */
export type ExtractMode =
  | "lastOutput"
  | "screen"
  | "timelineDelta"
  | ((state: SessionState) => string)

export interface AskOptions {
  /** Default 600_000 ms (10 min). */
  timeoutMs?: number
  /** Submit (press Enter) after sending the input. Default true. */
  submit?: boolean
  /** Cancellation. */
  abort?: AbortSignal

  /** PTY-scrape fallback when no outputFile. Default "lastOutput". */
  extract?: ExtractMode

  /**
   * File-as-message mode. When set:
   *   1. The ask appends an [OUTPUT INSTRUCTION] line to the prompt asking
   *      the agent to write its result to this path.
   *   2. The runtime waits for the file to appear (or update past its
   *      pre-call mtime) AND for the session to settle into one of
   *      `expectStates` (default ["waiting_input", "waiting_advance"]).
   *   3. The file content is read, parsed by `format`, and returned as
   *      `reply`.
   *
   * Path is resolved relative to the workflow's content-root unless it's
   * absolute or `outputFileResolution` overrides.
   */
  outputFile?: string

  /**
   * Pin where outputFile resolves from.
   *   "workspace"       — content/<workspaceId>.runtime/<outputFile> (default)
   *   "absolute"        — outputFile must start with /
   *   "cwd"             — relative to process.cwd()
   *   "messages"        — content/<workspaceId>.runtime/messages/<outputFile>
   */
  outputFileResolution?: "workspace" | "absolute" | "cwd" | "messages"

  /** Auto-parse format. Default "json" when extension is .json, else "text". */
  format?: "json" | "text" | "markdown" | "raw"

  /**
   * If true (default), include the resolved absolute outputFile path in the
   * appended instruction so the agent doesn't have to guess.
   */
  echoAbsolutePath?: boolean

  /**
   * Optional structured input passed in the prompt as a fenced code block.
   * Useful for: agent receiving previous step's output without us round-
   * tripping a JSON string through the user-visible prompt text.
   */
  context?: unknown
  contextFormat?: "json" | "yaml" | "markdown" | "text"

  /**
   * Pre-flight expectations. Runtime checks before sending input.
   *   "require_idle"     — fail if session isn't in one of expectStates
   *   "force_interrupt"  — send Ctrl-C and wait for idle if not idle
   *   "skip"             — don't pre-flight (default)
   */
  preflight?: "require_idle" | "force_interrupt" | "skip"
  expectStates?: SessionStateName[]

  /** How to wait for completion. */
  poll?: PollOptions

  /** Retry on transient errors. Default { count: 0 }. */
  retry?: RetryOptions

  /** Resolve outputFile via this workspace id. Falls back to env / opt-in. */
  workspaceId?: string

  /** Override the content root for path resolution. */
  contentRoot?: string
}

export interface PollOptions {
  intervalMs?: number // default 500
  via?: "http" | "ws" // default "http"
}

export interface RetryOptions {
  count: number
  backoffMs?: number
  on?: (e: Error) => boolean
}

export interface AskResult<T = unknown> {
  /** Default-extracted reply (file content parsed by format, or PTY scrape). */
  reply: T
  state: SessionStateName
  durationMs: number
  /**
   * The full session state at completion. Lets callers reach into
   * facts/timeline/timing/etc. without us pre-deciding which fields matter.
   */
  raw: SessionState
  /** When outputFile mode: the absolute path that was written. */
  outputFile?: string
}

// ─── Spawn ─────────────────────────────────────────────────────────────

export interface SpawnSpec {
  agent: "codex" | "claude" | "kimi" | "deepseek" | string
  role?: string
  cwd?: string
  model?: string
  workspaceId?: string
  initialPrompt?: string
  advance?: { mode: boolean; delayMs?: number }
  elevation?: boolean
  args?: string[]
  bridge?: BridgeRef
}

export interface SpawnResult {
  sessionId: string
  raw: SessionState
}

// ─── Errors ────────────────────────────────────────────────────────────

export class WorkflowRuntimeError extends Error {
  code: string
  details?: unknown
  constructor(message: string, code: string, details?: unknown) {
    super(message)
    this.name = "WorkflowRuntimeError"
    this.code = code
    this.details = details
  }
}

// ─── Misc ──────────────────────────────────────────────────────────────

export interface WaitFileOptions {
  timeoutMs?: number
  intervalMs?: number
  /**
   * If false (default), returns as soon as the file exists. If true, wait
   * until mtime advances past `mtimeFloor` — useful when the file already
   * exists from a prior run.
   */
  requireUpdate?: boolean
  mtimeFloor?: number
  /**
   * Stable-content check: poll the file two consecutive times; only return
   * once mtime stops changing (ms). Helpful when the agent is still writing.
   * Default 200 ms (zero disables).
   */
  stableMs?: number
  abort?: AbortSignal
}

export interface RuntimeContext {
  /** Absolute path to the content root that holds workspace folders. */
  contentRoot: string
  /** Default bridge endpoint when target.bridge isn't an explicit URL. */
  defaultBridge: BridgeEndpoint
  /** Workspace id used for path resolution when none provided per call. */
  workspaceId?: string
}
