import { registerWidget } from "../registry"
import type { Widget } from "../types"
// Styles live in widgets/styles.scss as a @use barrel (esbuild's
// inline-script loader doesn't accept direct .scss imports from .ts).
import {
  HEALTH_ARCHIVE_SCHEMA_VERSION,
  HEALTH_ARCHIVE_TYPE,
  HealthArchiveConfig,
  HealthArchiveConfigSchema,
} from "./schema"
import { mountHealthArchive } from "./renderer"

// The viewer pulls its data from the build-time /dashboard-aggregate.json
// (healthArchive section), so the widget itself doesn't need to fetch a
// per-page data.json — fetchData: false skips the bootstrap fetch.
const HealthArchiveWidget: Widget<HealthArchiveConfig> = {
  type: HEALTH_ARCHIVE_TYPE,
  schemaVersion: HEALTH_ARCHIVE_SCHEMA_VERSION,
  schema: HealthArchiveConfigSchema,
  fetchData: false,
  mount: mountHealthArchive,
}

registerWidget(HealthArchiveWidget)

export { HealthArchiveWidget }
export * from "./schema"
