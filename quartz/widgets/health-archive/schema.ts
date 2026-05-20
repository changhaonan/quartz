import { z } from "zod"

// Lightweight widget: doesn't carry any persistent data of its own. The
// archive months it renders come from /dashboard-aggregate.json which the
// build-time DashboardAggregate emitter produces by walking the
// dashboard/health/archive/*.runtime/data.json sidecars.

export const HEALTH_ARCHIVE_TYPE = "health-archive"
export const HEALTH_ARCHIVE_SCHEMA_VERSION = 1

// Empty config shape — the page can still pass title / etc through the
// markdown widget block, but nothing structural is required.
export const HealthArchiveConfigSchema = z.object({}).default({})
export type HealthArchiveConfig = z.infer<typeof HealthArchiveConfigSchema>
