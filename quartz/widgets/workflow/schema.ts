import { z } from "zod"

// Workflow board schema. Visually identical to illustration-board, but each
// node carries executable semantics (op = function name, params = configured
// arguments, outputs = named return values) and each edge's `varName` binds a
// source output to a target input. Codegen walks this DAG and produces a TS
// subset that an agent can run; parsing TS back into this shape is the
// reverse direction (deferred to v2).

export const WorkflowNodeKind = z.enum([
  // The executable kinds — they map to TS constructs at codegen time.
  "call",       // generic function/tool call: `out = op(...params, ...inputs)`
  "llm",        // LLM completion: `out = await llm(prompt, model, ...)`
  "ask",        // PTY ask:        `out = await ask(sessionId, prompt, opts?)`
  "spawn",      // PTY spawn:      `out = await spawn({ agent, ... })`
  "branch",     // decision diamond: yes/no, mapped to if/else
  "loop",       // stack with loopCount > 1, mapped to for-loop
  "parallel",   // lane/group containing independent branches; Promise.all
  "return",     // explicit return statement: `return <incoming-var>`
  // Visual-only kinds — codegen skips these (treated as comments).
  "note",
  "callout",
  "label",
])

export const WorkflowNodeColor = z.enum([
  "slate",
  "amber",
  "mint",
  "cyan",
  "rose",
  "violet",
])

export const WorkflowParamSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])

// Visual primitive (illustration kind) the canvas should render this node as.
// Defaults are picked from the executable kind; users can override if they
// want a non-standard look (e.g. render an llm-call as a stack).
export const WorkflowVisualKind = z.enum([
  "process",
  "decision",
  "stack",
  "lane",
  "group",
  "artifact",
  "note",
  "callout",
  "label",
])

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  kind: WorkflowNodeKind,
  visual: WorkflowVisualKind.optional(),
  op: z.string().default(""),
  params: z.record(z.string(), WorkflowParamSchema).default({}),
  outputs: z.array(z.string()).default(["out"]),
  containerId: z.string().default(""),
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  text: z.string().default(""),
  color: WorkflowNodeColor.default("slate"),
  ioPairs: z.number().int().min(1).max(6).default(1),
  loopCount: z.number().int().min(1).max(24).default(1),
})

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("arrow").default("arrow"),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().default(""),
  targetHandle: z.string().default(""),
  varName: z.string().default(""),
  // Free-form label is preserved alongside varName so users can annotate
  // edges in the visual mode without affecting codegen.
  label: z.string().default(""),
  color: WorkflowNodeColor.default("slate"),
  route: z
    .object({ x: z.number(), y: z.number() })
    .nullable()
    .default(null),
})

export const WorkflowBoardSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  // Top of the generated TS file — imports the user wants emitted verbatim.
  imports: z.array(z.string()).default([]),
  // Inputs the entrypoint function receives.
  entryParams: z.array(z.string()).default([]),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
})

export const WORKFLOW_BOARD_SCHEMA_VERSION = 1
export const WORKFLOW_BOARD_TYPE = "workflow-board"

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>
export type WorkflowBoardData = z.infer<typeof WorkflowBoardSchema>
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKind>
export type WorkflowVisualKind = z.infer<typeof WorkflowVisualKind>
export type WorkflowNodeColor = z.infer<typeof WorkflowNodeColor>

// Map executable kind → default visual primitive used by the illustration
// canvas. Workflow renderer overlays op/varName onto these.
export const KIND_TO_VISUAL: Record<WorkflowNodeKind, WorkflowVisualKind> = {
  call: "process",
  llm: "process",
  ask: "process",
  spawn: "artifact",
  branch: "decision",
  loop: "stack",
  parallel: "lane",
  return: "label",
  note: "note",
  callout: "callout",
  label: "label",
}

export function nodeVisualKind(node: WorkflowNode): WorkflowVisualKind {
  return node.visual ?? KIND_TO_VISUAL[node.kind]
}
