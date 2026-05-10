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
  mount: mountIllustrationBoard,
}

registerWidget(IllustrationBoardWidget)

export { IllustrationBoardWidget }
export * from "./schema"
