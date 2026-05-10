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
  // Rendering is delegated to the bridge canvas via iframe. Build-time
  // validation still runs against the schema (in the widget transformer);
  // we just don't pre-fetch + parse the JSON in the browser since the
  // bridge will do that itself.
  fetchData: false,
  mount: mountIllustrationBoard,
}

registerWidget(IllustrationBoardWidget)

export { IllustrationBoardWidget }
export * from "./schema"
