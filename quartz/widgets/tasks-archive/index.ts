import { registerWidget } from "../registry"
import type { Widget } from "../types"
import {
  TASKS_ARCHIVE_SCHEMA_VERSION,
  TASKS_ARCHIVE_TYPE,
  TasksArchiveConfig,
  TasksArchiveConfigSchema,
} from "./schema"
import { mountTasksArchive } from "./renderer"

const TasksArchiveWidget: Widget<TasksArchiveConfig> = {
  type: TASKS_ARCHIVE_TYPE,
  schemaVersion: TASKS_ARCHIVE_SCHEMA_VERSION,
  schema: TasksArchiveConfigSchema,
  fetchData: false,
  mount: mountTasksArchive,
}

registerWidget(TasksArchiveWidget)

export { TasksArchiveWidget }
export * from "./schema"
