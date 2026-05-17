// Build-time schema barrel. Imports ONLY zod schemas — no renderers, no
// preact, no DOM. Safe to import from Quartz transformers/emitters that
// run during SSG.
//
// Add a new widget here when you want it to participate in build-time
// validation.

import type { ZodType } from "zod"
import {
  ILLUSTRATION_BOARD_SCHEMA_VERSION,
  ILLUSTRATION_BOARD_TYPE,
  IllustrationBoardSchema,
} from "./illustration/schema"
import {
  WORKFLOW_BOARD_SCHEMA_VERSION,
  WORKFLOW_BOARD_TYPE,
  WorkflowBoardSchema,
} from "./workflow/schema"
import { DASHBOARD_SCHEMA_VERSION, DASHBOARD_TYPE, DashboardDataSchema } from "./dashboard/schema"

export interface WidgetSchemaDescriptor {
  schema: ZodType<unknown>
  version: number
}

export const widgetSchemas: Record<string, WidgetSchemaDescriptor> = {
  [ILLUSTRATION_BOARD_TYPE]: {
    schema: IllustrationBoardSchema,
    version: ILLUSTRATION_BOARD_SCHEMA_VERSION,
  },
  [WORKFLOW_BOARD_TYPE]: {
    schema: WorkflowBoardSchema,
    version: WORKFLOW_BOARD_SCHEMA_VERSION,
  },
  [DASHBOARD_TYPE]: {
    schema: DashboardDataSchema,
    version: DASHBOARD_SCHEMA_VERSION,
  },
}

export function getWidgetSchema(type: string): WidgetSchemaDescriptor | undefined {
  return widgetSchemas[type]
}

export function listWidgetTypes(): string[] {
  return Object.keys(widgetSchemas)
}
