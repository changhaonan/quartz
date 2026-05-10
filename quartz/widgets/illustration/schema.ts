import { z } from "zod"

// Schema mirrors the canonical bridge illustration model so .runtime/board.json
// files round-trip between Quartz and the bridge dashboard without drift.
// Source of truth: claude_pty/client/src/blueprint/illustration.js.

export const NodeKind = z.enum([
  "stack",
  "process",
  "decision",
  "artifact",
  "lane",
  "callout",
  "note",
  "label",
  "group",
])

export const NodeColor = z.enum([
  "slate",
  "amber",
  "mint",
  "cyan",
  "rose",
  "violet",
])

export const NODE_TYPE_DEFAULTS: Record<
  z.infer<typeof NodeKind>,
  { width: number; height: number; label: string }
> = {
  stack: { width: 320, height: 232, label: "Stack" },
  process: { width: 260, height: 132, label: "Process" },
  decision: { width: 232, height: 232, label: "Decision" },
  artifact: { width: 266, height: 138, label: "Artifact" },
  lane: { width: 380, height: 260, label: "Lane" },
  callout: { width: 270, height: 150, label: "Callout" },
  note: { width: 260, height: 144, label: "Note" },
  label: { width: 220, height: 84, label: "Label" },
  group: { width: 360, height: 240, label: "Group" },
}

export const NODE_COLOR_ACCENTS: Record<z.infer<typeof NodeColor>, string> = {
  slate: "#91a4bb",
  amber: "#f2b84c",
  mint: "#57c4aa",
  cyan: "#63c6ff",
  rose: "#ef8fb1",
  violet: "#a890ff",
}

export const IllustrationRouteSchema = z
  .object({ x: z.number(), y: z.number() })
  .nullable()
  .default(null)

export const IllustrationNodeSchema = z.object({
  id: z.string().min(1),
  type: NodeKind,
  containerId: z.string().default(""),
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  text: z.string().default(""),
  color: NodeColor.default("slate"),
  ioPairs: z.number().int().min(1).max(6).default(1),
  loopCount: z.number().int().min(1).max(24).default(1),
})

export const IllustrationEdgeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("arrow").default("arrow"),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().default(""),
  targetHandle: z.string().default(""),
  label: z.string().default(""),
  color: NodeColor.default("slate"),
  route: IllustrationRouteSchema,
})

export const IllustrationBoardSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  nodes: z.array(IllustrationNodeSchema),
  edges: z.array(IllustrationEdgeSchema),
})

export const ILLUSTRATION_BOARD_SCHEMA_VERSION = 1
export const ILLUSTRATION_BOARD_TYPE = "illustration-board"

export type IllustrationNode = z.infer<typeof IllustrationNodeSchema>
export type IllustrationEdge = z.infer<typeof IllustrationEdgeSchema>
export type IllustrationBoardData = z.infer<typeof IllustrationBoardSchema>
export type IllustrationNodeKind = z.infer<typeof NodeKind>
export type IllustrationNodeColor = z.infer<typeof NodeColor>
export type IllustrationRoute = z.infer<typeof IllustrationRouteSchema>

export function nodeSize(node: IllustrationNode): { width: number; height: number } {
  const meta = NODE_TYPE_DEFAULTS[node.type]
  return {
    width: node.width ?? meta.width,
    height: node.height ?? meta.height,
  }
}

export function isYesBranch(edge: IllustrationEdge): boolean {
  return edge.sourceHandle === "source-top"
}

export function isNoBranch(edge: IllustrationEdge): boolean {
  return edge.sourceHandle === "source-bottom"
}

export function branchLabel(edge: IllustrationEdge): string {
  if (edge.label) return edge.label
  if (isYesBranch(edge)) return "Yes"
  if (isNoBranch(edge)) return "No"
  return ""
}
