import { z } from "zod"

export const TASKS_ARCHIVE_TYPE = "tasks-archive"
export const TASKS_ARCHIVE_SCHEMA_VERSION = 1

// No persistent state — viewer pulls from /dashboard-aggregate.json.
export const TasksArchiveConfigSchema = z.object({}).default({})
export type TasksArchiveConfig = z.infer<typeof TasksArchiveConfigSchema>
