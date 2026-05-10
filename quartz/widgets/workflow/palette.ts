// Workflow-specific palette. Each entry maps to a Workflow node `kind`,
// pre-fills a sensible op/visual default. Visual rendering in the canvas
// uses the existing illustration node component (process/decision/stack/
// lane/etc.); kind drives codegen.

import type { ComponentType } from "react"
import {
  Brain,
  GitBranch,
  Layers,
  Network,
  Play,
  StickyNote,
} from "lucide-react"

export interface WorkflowPaletteEntry {
  type: "call" | "llm" | "branch" | "loop" | "parallel" | "note"
  label: string
  color: "slate" | "amber" | "mint" | "cyan" | "rose" | "violet"
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>
  defaultText: string
  visual:
    | "process"
    | "decision"
    | "stack"
    | "lane"
    | "group"
    | "artifact"
    | "note"
    | "callout"
    | "label"
  op: string
}

export const WORKFLOW_PALETTE: WorkflowPaletteEntry[] = [
  { type: "call", label: "Call", color: "cyan", Icon: Play, defaultText: "fn(input)", visual: "process", op: "callFn" },
  { type: "llm", label: "LLM", color: "violet", Icon: Brain, defaultText: "llm(prompt)", visual: "process", op: "llm" },
  { type: "branch", label: "Branch", color: "rose", Icon: GitBranch, defaultText: "predicate?", visual: "decision", op: "" },
  { type: "loop", label: "Loop", color: "violet", Icon: Layers, defaultText: "for i in N", visual: "stack", op: "" },
  { type: "parallel", label: "Parallel", color: "mint", Icon: Network, defaultText: "Promise.all", visual: "lane", op: "" },
  { type: "note", label: "Note", color: "amber", Icon: StickyNote, defaultText: "comment", visual: "note", op: "" },
]
