import { registerWidget } from "../registry"
import type { Widget } from "../types"
import { DASHBOARD_SCHEMA_VERSION, DASHBOARD_TYPE, DashboardData, DashboardDataSchema } from "./schema"
import { mountDashboard } from "./renderer"

const DashboardWidget: Widget<DashboardData> = {
  type: DASHBOARD_TYPE,
  schemaVersion: DASHBOARD_SCHEMA_VERSION,
  schema: DashboardDataSchema,
  // The bootstrap fetches + validates data.json (goals / metrics) before
  // mount. The renderer fetches /dashboard-aggregate.json separately for the
  // build-time aggregated sections (finance, workflows, thoughts, bridge).
  fetchData: true,
  mount: mountDashboard,
}

registerWidget(DashboardWidget)

export { DashboardWidget }
export * from "./schema"
