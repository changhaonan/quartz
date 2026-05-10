import type { ComponentType, ReactElement, ReactNode } from "react"
import type { JsonPatchOp } from "../types"

export interface BoardCanvasNode {
  id: string
  type: string
  containerId?: string
  x: number
  y: number
  width?: number
  height?: number
  text?: string
  color?: string
  ioPairs?: number
  loopCount?: number
  // Widget-specific fields are tolerated; the canvas just renders the
  // common visual subset and round-trips the rest through onChange.
  [key: string]: unknown
}

export interface BoardCanvasEdge {
  id: string
  type?: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  label?: string
  color?: string
  route?: { x: number; y: number } | null
  [key: string]: unknown
}

export interface BoardCanvasData {
  schemaVersion?: number
  nodes: BoardCanvasNode[]
  edges: BoardCanvasEdge[]
}

export interface BoardPaletteEntry {
  type: string
  label: string
  color: string
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>
  defaultText: string
}

export interface BoardCanvasProps {
  data: BoardCanvasData
  mode: "readonly" | "live"
  onChange?: (patch: JsonPatchOp[]) => void
  palette?: BoardPaletteEntry[]
  extraToolbarRight?: ReactNode
}

declare function BoardCanvas(props: BoardCanvasProps): ReactElement
export default BoardCanvas
