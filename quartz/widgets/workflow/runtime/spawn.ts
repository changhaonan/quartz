import { ask } from "./ask.ts"
import { createSession, resolveBridge } from "./bridge.ts"
import { type AskTarget, type SpawnResult, type SpawnSpec } from "./types.ts"

/**
 * Create a new PTY session through the bridge. Optionally send an initial
 * prompt and wait for the agent to settle, returning the spawned session
 * along with its first reply if a prompt was provided.
 */
export async function spawn(spec: SpawnSpec): Promise<SpawnResult & { firstReply?: unknown }> {
  const endpoint = resolveBridge(spec.bridge)
  const body: Record<string, unknown> = {
    agent: spec.agent,
  }
  if (spec.role) body.roleId = spec.role
  if (spec.cwd) body.cwd = spec.cwd
  if (spec.model) body.model = spec.model
  if (spec.workspaceId) body.workspaceId = spec.workspaceId
  if (spec.advance) {
    body.advanceMode = spec.advance.mode
    if (typeof spec.advance.delayMs === "number") body.advanceDelayMs = spec.advance.delayMs
  }
  if (spec.elevation) body.elevated = true
  if (spec.args && spec.args.length > 0) body.args = spec.args

  const created = await createSession(endpoint, body)
  const result: SpawnResult & { firstReply?: unknown } = {
    sessionId: created.sessionId,
    raw: created.raw,
  }

  if (spec.initialPrompt) {
    const target: AskTarget = { sessionId: created.sessionId, bridge: spec.bridge }
    const ack = await ask(target, spec.initialPrompt, { extract: "lastOutput" })
    result.firstReply = ack.reply
  }

  return result
}
