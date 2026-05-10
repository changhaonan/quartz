import type { ReactElement } from "react"
import type { IllustrationBoardData } from "../schema"
import type { JsonPatchOp } from "../types"

interface IllustrationCanvasProps {
  data: IllustrationBoardData
  mode: "readonly" | "live"
  onChange?: (patch: JsonPatchOp[]) => void
}

declare function IllustrationCanvas(props: IllustrationCanvasProps): ReactElement
export default IllustrationCanvas
