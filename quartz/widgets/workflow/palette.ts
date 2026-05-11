// Workflow-specific palette. Each entry maps to a Workflow node `kind`,
// pre-fills a sensible op/visual default. Visual rendering in the canvas
// uses the existing illustration node component (process/decision/stack/
// lane/etc.); kind drives codegen.

import type { ComponentType } from "react"
import {
  Brain,
  GitBranch,
  Keyboard,
  Layers,
  MessageCircle,
  Network,
  Play,
  Plus,
  StickyNote,
} from "lucide-react"

export interface WorkflowPaletteEntry {
  type:
    | "call"
    | "llm"
    | "ask"
    | "spawn"
    | "input"
    | "branch"
    | "loop"
    | "parallel"
    | "note"
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
    | "input"
    | "note"
    | "callout"
    | "label"
  op: string
}

export const WORKFLOW_PALETTE: WorkflowPaletteEntry[] = [
  { type: "ask", label: "Ask", color: "cyan", Icon: MessageCircle, defaultText: "ask(session, prompt)", visual: "process", op: "ask" },
  { type: "spawn", label: "Spawn", color: "violet", Icon: Plus, defaultText: "spawn(role)", visual: "artifact", op: "spawn" },
  { type: "call", label: "Call", color: "cyan", Icon: Play, defaultText: "fn(input)", visual: "process", op: "callFn" },
  { type: "llm", label: "LLM", color: "violet", Icon: Brain, defaultText: "llm(prompt)", visual: "process", op: "llm" },
  { type: "input", label: "Input", color: "amber", Icon: Keyboard, defaultText: "userInput(text)", visual: "input", op: "userInput" },
  { type: "branch", label: "Branch", color: "rose", Icon: GitBranch, defaultText: "predicate?", visual: "decision", op: "" },
  { type: "loop", label: "Loop", color: "violet", Icon: Layers, defaultText: "for i in N", visual: "stack", op: "" },
  { type: "parallel", label: "Parallel", color: "mint", Icon: Network, defaultText: "Promise.all", visual: "lane", op: "" },
  { type: "note", label: "Note", color: "amber", Icon: StickyNote, defaultText: "comment", visual: "note", op: "" },
]
