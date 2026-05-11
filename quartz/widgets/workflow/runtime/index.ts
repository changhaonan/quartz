// Public entry for workflow runtime. Generated workflow.ts files import from
// here. Bridge URL defaults to http://127.0.0.1:3210; override with
// setRuntimeContext({ defaultBridge: { baseUrl: ... } }) or via the
// WORKFLOW_BRIDGE_URL env var.

export { ask, getRuntimeContext, setRuntimeContext } from "./ask.ts"
export { spawn } from "./spawn.ts"
export { userInput } from "./userInput.ts"
export {
  fileTicket,
  completeTicket,
  cancelTicket,
  releaseAllOpenTickets,
} from "./tickets.ts"
export type { TicketHandle, TicketSpec } from "./tickets.ts"
export {
  input,
  submit,
  interrupt,
  read,
  waitFor,
  waitForState,
} from "./primitives.ts"
export {
  messagePath,
  readJsonFile,
  readTextFile,
  resolveOutputPath,
  waitForFile,
  writeAtomic,
  writeJsonAtomic,
  detectFormat,
  readByFormat,
} from "./files.ts"
export { setDefaultBridge, resolveBridge, probeBridgeHealth } from "./bridge.ts"
export type {
  AskOptions,
  AskResult,
  AskTarget,
  AskTargetSpec,
  BridgeEndpoint,
  BridgeRef,
  ExtractMode,
  PollOptions,
  RetryOptions,
  RuntimeContext,
  SessionState,
  SessionStateName,
  SpawnResult,
  SpawnSpec,
  UserInputRequest,
  UserInputResponse,
  UserInputSpec,
  UserInputType,
  WaitFileOptions,
} from "./types.ts"
export { WorkflowRuntimeError } from "./types.ts"
