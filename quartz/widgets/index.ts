// Side-effect imports: each widget module registers itself with the
// client-side registry on import. Add new widgets here.
import "./illustration"
import "./workflow"
import "./dashboard"
import "./health-archive"
import "./tasks-archive"

export { registerWidget, getWidget, listWidgets } from "./registry"
export { fetchWidgetData, writeWidget } from "./client"
export type {
  Widget,
  WidgetMode,
  WidgetMountContext,
  WidgetCapabilities,
  WidgetWriteRequest,
  WidgetWriteResult,
  WidgetDispose,
  JsonPatchOp,
} from "./types"
