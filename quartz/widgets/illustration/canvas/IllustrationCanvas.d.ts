import type { ReactElement } from "react"
import type { IllustrationBoardData } from "../schema"

interface NodeMoveEvent {
  id: string
  index: number
  x: number
  y: number
}

interface IllustrationCanvasProps {
  data: IllustrationBoardData
  mode: "readonly" | "live"
  onNodeMove?: (event: NodeMoveEvent) => void
}

declare function IllustrationCanvas(props: IllustrationCanvasProps): ReactElement
export default IllustrationCanvas
