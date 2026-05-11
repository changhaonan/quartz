// Human-in-the-loop prompt primitive. The running workflow subprocess writes
// a request file under its runDir; the browser polls that directory, renders
// a Gradio-style form, and writes a response file when the user submits.
// We then read the response and return the user's value. File-based handoff
// matches the rest of the runtime's design — no IPC sockets, no shared
// memory, just two atomic JSON files per prompt.
//
// Path layout (relative to runDir):
//   inputs/<reqId>.request.json    — written by the subprocess
//   inputs/<reqId>.response.json   — written by /api/workflow/input
//
// The reqId is short + url-safe so it can show up in stdout logs without
// escaping. We deliberately leave both files on disk after the round-trip:
// they're a useful audit trail (what was asked, what was answered, when).

import path from "node:path"
import { getRuntimeContext } from "./ask.ts"
import { waitForFile, writeJsonAtomic, readJsonFile } from "./files.ts"
import {
  type UserInputRequest,
  type UserInputResponse,
  type UserInputSpec,
  WorkflowRuntimeError,
} from "./types.ts"

function nextReqId(): string {
  // 6 chars of base36 — plenty of entropy for the requests-per-run scale.
  return Math.random().toString(36).slice(2, 8)
}

/**
 * Prompt the user via the browser's workflow Run panel. Returns the value
 * the user submitted, coerced into the type implied by `spec.inputType`
 * (string for "text"/"select", number for "number", boolean for "boolean").
 *
 * Throws WorkflowRuntimeError if:
 *   - runDir isn't set (workflow wasn't launched via the run-driver)
 *   - the user doesn't respond within spec.timeoutMs (default 10 min)
 *   - the response file contains an unparseable payload
 */
export async function userInput<T = string | number | boolean>(
  spec: UserInputSpec,
): Promise<T> {
  const ctx = getRuntimeContext()
  if (!ctx.runDir) {
    throw new WorkflowRuntimeError(
      "userInput requires a runDir on the runtime context — launch the workflow via the run-driver (or set runDir manually for tests).",
      "no_run_dir",
      { spec },
    )
  }
  const reqId = nextReqId()
  const inputsDir = path.join(ctx.runDir, "inputs")
  const requestPath = path.join(inputsDir, `${reqId}.request.json`)
  const responsePath = path.join(inputsDir, `${reqId}.response.json`)

  const request: UserInputRequest = {
    reqId,
    spec,
    requestedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(requestPath, request)
  console.log(`[userInput] waiting on label="${spec.label ?? spec.inputType}"...`)
  const _t0 = Date.now()

  let response: UserInputResponse
  try {
    await waitForFile(responsePath, {
      timeoutMs: spec.timeoutMs ?? 600_000,
      // Inputs dir is per-run, so we can't have a stale response from a
      // previous run — requireUpdate stays false.
      stableMs: 50,
    })
    response = await readJsonFile<UserInputResponse>(responsePath)
  } catch (e) {
    if ((e as WorkflowRuntimeError).code === "timeout") {
      throw new WorkflowRuntimeError(
        `userInput("${spec.label ?? spec.inputType}") timed out waiting for response after ${spec.timeoutMs ?? 600_000}ms`,
        "input_timeout",
        { reqId, requestPath, spec },
      )
    }
    throw e
  }
  if (response.reqId !== reqId) {
    throw new WorkflowRuntimeError(
      `userInput response reqId mismatch: expected ${reqId}, got ${response.reqId}`,
      "bad_response",
      { reqId, response },
    )
  }
  console.log(`[userInput] got response after ${((Date.now() - _t0) / 1000).toFixed(1)}s`)
  return coerceValue(response.value, spec.inputType) as T
}

function coerceValue(
  raw: unknown,
  inputType: UserInputSpec["inputType"],
): string | number | boolean {
  if (inputType === "number") {
    const n = typeof raw === "number" ? raw : Number(raw)
    if (Number.isNaN(n)) {
      throw new WorkflowRuntimeError(
        `userInput expected a number, got ${JSON.stringify(raw)}`,
        "bad_response",
      )
    }
    return n
  }
  if (inputType === "boolean") {
    if (typeof raw === "boolean") return raw
    if (raw === "true" || raw === "yes" || raw === "1" || raw === 1) return true
    if (raw === "false" || raw === "no" || raw === "0" || raw === 0 || raw === "") return false
    throw new WorkflowRuntimeError(
      `userInput expected a boolean, got ${JSON.stringify(raw)}`,
      "bad_response",
    )
  }
  // text / select — strings
  return String(raw ?? "")
}
