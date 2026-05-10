import { registerWidget } from "../registry"
import type { Widget } from "../types"
import {
  ILLUSTRATION_BOARD_SCHEMA_VERSION,
  ILLUSTRATION_BOARD_TYPE,
  IllustrationBoardData,
  IllustrationBoardSchema,
} from "./schema"
import { mountIllustrationBoard } from "./renderer"

const IllustrationBoardWidget: Widget<IllustrationBoardData> = {
  type: ILLUSTRATION_BOARD_TYPE,
  schemaVersion: ILLUSTRATION_BOARD_SCHEMA_VERSION,
  schema: IllustrationBoardSchema,
  // Native React island. The bootstrap fetches and validates the JSON
  // before mount; the renderer hosts a React Flow canvas using the
  // illustration node/edge components ported from claude_pty.
  fetchData: true,
  mount: mountIllustrationBoard,
}

registerWidget(IllustrationBoardWidget)

export { IllustrationBoardWidget }
export * from "./schema"
