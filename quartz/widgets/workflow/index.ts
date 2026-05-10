import { registerWidget } from "../registry"
import type { Widget } from "../types"
import {
  WORKFLOW_BOARD_SCHEMA_VERSION,
  WORKFLOW_BOARD_TYPE,
  WorkflowBoardData,
  WorkflowBoardSchema,
} from "./schema"
import { mountWorkflowBoard } from "./renderer"

const WorkflowBoardWidget: Widget<WorkflowBoardData> = {
  type: WORKFLOW_BOARD_TYPE,
  schemaVersion: WORKFLOW_BOARD_SCHEMA_VERSION,
  schema: WorkflowBoardSchema,
  fetchData: true,
  mount: mountWorkflowBoard,
}

registerWidget(WorkflowBoardWidget)

export { WorkflowBoardWidget }
export * from "./schema"
export { generateWorkflowSource } from "./codegen"
