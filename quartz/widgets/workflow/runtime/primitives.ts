// Lower-level primitives that ask() composes. Exposed so power-users can
// drop down a layer when the high-level ask doesn't fit.

import {
  getSessionState,
  resolveBridge,
  sendInput,
  sendInterrupt,
  sendSubmit,
  waitForSessionState,
} from "./bridge.ts"
import type { AskTarget, SessionState, SessionStateName } from "./types.ts"

function endpointFor(target: AskTarget) {
  if (typeof target === "string") {
    return { endpoint: resolveBridge(), sessionId: target }
  }
  return { endpoint: resolveBridge(target.bridge), sessionId: target.sessionId }
}

export async function input(
  target: AskTarget,
  text: string,
  opts: { submit?: boolean } = {},
): Promise<void> {
  const { endpoint, sessionId } = endpointFor(target)
  await sendInput(endpoint, sessionId, text, { submit: opts.submit !== false })
}

export async function submit(target: AskTarget): Promise<void> {
  const { endpoint, sessionId } = endpointFor(target)
  await sendSubmit(endpoint, sessionId)
}

export async function interrupt(
  target: AskTarget,
  signal: "SIGINT" | "SIGTERM" = "SIGINT",
): Promise<void> {
  const { endpoint, sessionId } = endpointFor(target)
  await sendInterrupt(endpoint, sessionId, signal)
}

export async function read(target: AskTarget): Promise<SessionState> {
  const { endpoint, sessionId } = endpointFor(target)
  return getSessionState(endpoint, sessionId)
}

export async function waitFor(
  target: AskTarget,
  predicate: (state: SessionState) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; abort?: AbortSignal } = {},
): Promise<SessionState> {
  const { endpoint, sessionId } = endpointFor(target)
  return waitForSessionState(endpoint, sessionId, {
    expect: [],
    predicate,
    ...opts,
  })
}

export async function waitForState(
  target: AskTarget,
  expect: SessionStateName | SessionStateName[],
  opts: { timeoutMs?: number; intervalMs?: number; abort?: AbortSignal } = {},
): Promise<SessionState> {
  const { endpoint, sessionId } = endpointFor(target)
  return waitForSessionState(endpoint, sessionId, {
    expect: Array.isArray(expect) ? expect : [expect],
    ...opts,
  })
}
