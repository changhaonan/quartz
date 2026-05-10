// Thin HTTP wrapper around bridge endpoints. Knows nothing about workflows
// or files — pure session-API client. Mockable via BridgeEndpoint.fetch.

import type {
  BridgeEndpoint,
  BridgeRef,
  SessionState,
  SessionStateName,
} from "./types.ts"
import { WorkflowRuntimeError } from "./types.ts"

const BRIDGE_DEFAULT_BASE = "http://127.0.0.1:3210"
const BRIDGE_PEER_BASE =
  process.env.WORKFLOW_BRIDGE_PEER_URL || "http://127.0.0.1:3001"

// Module-level mutable so tests can swap "self" without touching every call.
let runtimeContextDefault: BridgeEndpoint = {
  baseUrl: process.env.WORKFLOW_BRIDGE_URL || BRIDGE_DEFAULT_BASE,
}

export function setDefaultBridge(endpoint: Partial<BridgeEndpoint>) {
  runtimeContextDefault = { ...runtimeContextDefault, ...endpoint }
}

export function resolveBridge(ref?: BridgeRef): BridgeEndpoint {
  if (!ref || ref === "self") return runtimeContextDefault
  if (ref === "peer") return { baseUrl: BRIDGE_PEER_BASE }
  if (typeof ref === "string") return { baseUrl: ref }
  return ref
}

async function bridgeFetch(
  endpoint: BridgeEndpoint,
  method: string,
  pathName: string,
  body?: unknown,
  init?: RequestInit,
): Promise<Response> {
  const url = endpoint.baseUrl.replace(/\/$/, "") + pathName
  const fetchImpl = endpoint.fetch ?? fetch
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (endpoint.authToken) {
    headers.authorization = `Bearer ${endpoint.authToken}`
  }
  return fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  })
}

async function asJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    let bodyText = ""
    try {
      bodyText = await res.text()
    } catch {}
    throw new WorkflowRuntimeError(
      `bridge ${label} failed: ${res.status} ${res.statusText} :: ${bodyText.slice(0, 400)}`,
      `bridge_http_${res.status}`,
      { url: (res as unknown as { url?: string }).url, status: res.status },
    )
  }
  return (await res.json()) as T
}

// ─── Session reads ────────────────────────────────────────────────────

export async function getSessionState(
  endpoint: BridgeEndpoint,
  sessionId: string,
): Promise<SessionState> {
  const res = await bridgeFetch(
    endpoint,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  )
  return asJson<SessionState>(res, "getSessionState")
}

// ─── Session writes ───────────────────────────────────────────────────

export async function sendInput(
  endpoint: BridgeEndpoint,
  sessionId: string,
  data: string,
  opts: { submit?: boolean; from?: string } = {},
): Promise<unknown> {
  const res = await bridgeFetch(
    endpoint,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/input`,
    {
      data,
      submit: opts.submit !== false,
      from: opts.from,
    },
  )
  return asJson<unknown>(res, "sendInput")
}

export async function sendSubmit(
  endpoint: BridgeEndpoint,
  sessionId: string,
): Promise<unknown> {
  const res = await bridgeFetch(
    endpoint,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/submit`,
  )
  return asJson<unknown>(res, "sendSubmit")
}

export async function sendInterrupt(
  endpoint: BridgeEndpoint,
  sessionId: string,
  signal: "SIGINT" | "SIGTERM" = "SIGINT",
): Promise<unknown> {
  // Bridge's interrupt path varies by version; we POST to a conventional URL
  // and fall back to sending Ctrl-C via /input as a backup.
  const res = await bridgeFetch(
    endpoint,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
    { signal },
  )
  if (res.status === 404) {
    return sendInput(endpoint, sessionId, "", { submit: false })
  }
  return asJson<unknown>(res, "sendInterrupt")
}

export async function createSession(
  endpoint: BridgeEndpoint,
  spec: Record<string, unknown>,
): Promise<{ sessionId: string; raw: SessionState }> {
  const res = await bridgeFetch(endpoint, "POST", "/api/sessions", spec)
  const data = await asJson<SessionState & { sessionId?: string }>(
    res,
    "createSession",
  )
  const sessionId = data.sessionId ?? (data as { id?: string }).id
  if (!sessionId || typeof sessionId !== "string") {
    throw new WorkflowRuntimeError(
      `createSession: bridge returned no sessionId`,
      "bridge_protocol",
      { data },
    )
  }
  return { sessionId, raw: data }
}

// ─── Polling helper ───────────────────────────────────────────────────

export interface WaitForStateOptions {
  expect: SessionStateName[]
  /** Reject (return false) if the session enters one of these instead. */
  reject?: SessionStateName[]
  timeoutMs?: number
  intervalMs?: number
  abort?: AbortSignal
  /** When set, only count states observed at >= this timestamp. */
  notBefore?: number
  /** Custom predicate that overrides expect/reject. */
  predicate?: (state: SessionState) => boolean
}

export async function waitForSessionState(
  endpoint: BridgeEndpoint,
  sessionId: string,
  opts: WaitForStateOptions,
): Promise<SessionState> {
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 600000
  const intervalMs = opts.intervalMs ?? 500
  while (true) {
    if (opts.abort?.aborted) {
      throw new WorkflowRuntimeError("waitForSessionState aborted", "aborted")
    }
    const state = await getSessionState(endpoint, sessionId)
    if (opts.predicate) {
      if (opts.predicate(state)) return state
    } else {
      if (opts.reject?.includes(state.state)) {
        throw new WorkflowRuntimeError(
          `session ${sessionId} entered rejected state ${state.state}`,
          "rejected_state",
          { state },
        )
      }
      if (opts.expect.includes(state.state)) {
        // Honor `notBefore` so we don't return a pre-existing waiting_input
        // state from before we sent our input.
        if (!opts.notBefore || Date.now() >= opts.notBefore) {
          return state
        }
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new WorkflowRuntimeError(
        `waitForSessionState timeout after ${timeoutMs}ms (last state: ${state.state})`,
        "timeout",
        { state },
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ─── Health probe ─────────────────────────────────────────────────────

export async function probeBridgeHealth(
  endpoint: BridgeEndpoint,
): Promise<boolean> {
  try {
    const res = await bridgeFetch(endpoint, "GET", "/api/health")
    return res.ok
  } catch {
    return false
  }
}
