import { z } from "zod"

export const NodeKind = z.enum([
  "note",
  "process",
  "artifact",
  "actor",
  "decision",
])

export const NodeColor = z.enum([
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "gray",
])

export const IllustrationNodeSchema = z.object({
  id: z.string().min(1),
  type: NodeKind,
  x: z.number(),
  y: z.number(),
  width: z.number().positive().default(280),
  height: z.number().positive().default(120),
  title: z.string().default(""),
  text: z.string().default(""),
  color: NodeColor.default("gray"),
})

export const IllustrationEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().default("illustration"),
  label: z.string().default(""),
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
