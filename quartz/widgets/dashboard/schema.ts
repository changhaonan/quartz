import { z } from "zod"

// The dashboard widget's *data file* (data.json) only holds user-editable
// state: goals and custom KPI cards. Everything else shown on the panel —
// finance, workflow runs, thoughts activity, bridge sessions/tickets — is
// build-time aggregated into /dashboard-aggregate.json by the
// DashboardAggregate emitter and fetched separately at render time.

export const DASHBOARD_TYPE = "dashboard"
export const DASHBOARD_SCHEMA_VERSION = 1

// Cadence buckets a goal on the panel. "main" = long-term / quarterly; it is
// also the default so goals authored before this field existed still render.
export const GoalCadenceSchema = z.enum(["daily", "weekly", "main"]).default("main")
export type GoalCadence = z.infer<typeof GoalCadenceSchema>

// A goal's coarse status — the Notion "Status" property. This *is* the
// progress indicator: no fine-grained percentage.
export const GoalStatusSchema = z.enum(["todo", "doing", "done"]).default("todo")
export type GoalStatus = z.infer<typeof GoalStatusSchema>

// Priority — Notion "Priority" property. "none" = unset.
export const GoalPrioritySchema = z.enum(["none", "low", "mid", "high"]).default("none")
export type GoalPriority = z.infer<typeof GoalPrioritySchema>

// One timestamped progress note. The goal's `log` accumulates these into a
// timeline so "where is this task at" is recorded as it changes.
export const GoalLogEntrySchema = z.object({
  // ISO timestamp of when the entry was written.
  at: z.string(),
  text: z.string().default(""),
})
export type GoalLogEntry = z.infer<typeof GoalLogEntrySchema>

export const DashboardGoalSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  note: z.string().default(""),
  status: GoalStatusSchema,
  priority: GoalPrioritySchema,
  // Free-form labels, shown as chips.
  tags: z.array(z.string()).default([]),
  // ISO date (yyyy-mm-dd), or "" when unset.
  dueDate: z.string().default(""),
  // Progress timeline — oldest-first; the card shows it newest-first.
  log: z.array(GoalLogEntrySchema).default([]),
  // Which board column the goal shows under: 每日 / 每周 / 主要.
  cadence: GoalCadenceSchema,
})

// View toolbar state for the goals board — filters + sort. Persisted with the
// data so the chosen view survives reloads. "all" / "" / "manual" = unset.
export const DashboardViewSchema = z.object({
  filterStatus: z.enum(["all", "todo", "doing", "done"]).default("all"),
  filterPriority: z.enum(["all", "none", "low", "mid", "high"]).default("all"),
  filterTag: z.string().default(""),
  sort: z.enum(["manual", "priority", "dueDate", "status"]).default("manual"),
})
export type DashboardView = z.infer<typeof DashboardViewSchema>

export const DashboardMetricSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  // Kept as a string so the card can show "42", "3.5h", "—", etc.
  value: z.string().default(""),
  unit: z.string().default(""),
  note: z.string().default(""),
  trend: z.enum(["up", "down", "flat", "none"]).default("none"),
})

export const DashboardDataSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string().default("主面板"),
  goals: z.array(DashboardGoalSchema).default([]),
  metrics: z.array(DashboardMetricSchema).default([]),
  view: DashboardViewSchema.default({
    filterStatus: "all",
    filterPriority: "all",
    filterTag: "",
    sort: "manual",
  }),
})

export type DashboardGoal = z.infer<typeof DashboardGoalSchema>
export type DashboardMetric = z.infer<typeof DashboardMetricSchema>
export type DashboardData = z.infer<typeof DashboardDataSchema>
