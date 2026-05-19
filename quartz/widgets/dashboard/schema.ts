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

// Personal life vs work / company — explicit, so the summary count and
// the visual marker on the card don't depend on a "work" tag the user
// has to remember to add. Default "personal" — the common case.
export const GoalKindSchema = z.enum(["personal", "work"]).default("personal")
export type GoalKind = z.infer<typeof GoalKindSchema>

// Coarse effort bucket — S / M / L — instead of a literal minute count.
// "" = unset; the AI estimate or a click picks one.
export const GoalSizeSchema = z.enum(["", "S", "M", "L"]).default("")
export type GoalSize = z.infer<typeof GoalSizeSchema>

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
  // Personal vs work — explicit classification, replaces the implicit
  // tag-based detection.
  kind: GoalKindSchema,
  // Coarse effort bucket (S/M/L). Editable; ✨ button asks codex.
  size: GoalSizeSchema,
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

// --- Health log (manually entered, in addition to Apple Health import) ------

// Meal slot a calorie entry belongs to.
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const
export const MealTypeSchema = z.enum(MEAL_TYPES).default("breakfast")
export type MealType = z.infer<typeof MealTypeSchema>

// One manually-logged body-weight reading. Merged by date with the Apple
// Health imported samples for the weight trend — a manual entry wins for
// its date, so you can correct or fill a day the phone didn't push.
export const WeightEntrySchema = z.object({
  id: z.string().min(1),
  date: z.string().default(""), // local YYYY-MM-DD
  kg: z.number().default(0),
})
export type WeightEntry = z.infer<typeof WeightEntrySchema>

// One logged meal — what was eaten and its calories.
export const MealEntrySchema = z.object({
  id: z.string().min(1),
  date: z.string().default(""), // local YYYY-MM-DD
  meal: MealTypeSchema,
  food: z.string().default(""),
  kcal: z.number().default(0),
})
export type MealEntry = z.infer<typeof MealEntrySchema>

// One logged exercise — what + calories burned. Mirrors MealEntry so the
// same in-place editing pattern (and the AI estimate button) works.
export const ExerciseEntrySchema = z.object({
  id: z.string().min(1),
  date: z.string().default(""), // local YYYY-MM-DD
  name: z.string().default(""),
  kcal: z.number().default(0),
})
export type ExerciseEntry = z.infer<typeof ExerciseEntrySchema>

// Body profile — feeds the Mifflin-St Jeor BMR estimate, plus the
// per-kind weekly capacities the goals load% is divided against. Each
// field is optional / has a sensible default.
export const DashboardProfileSchema = z.object({
  heightCm: z.number().default(0),
  birthDate: z.string().default(""), // YYYY-MM-DD
  sex: z.enum(["male", "female", ""]).default(""),
  // Concurrent-in-progress caps per goal size, per kind. The load% on
  // the summary pill = max over tiers of (doing-count / cap). "Doing" is
  // the only status that counts — todo (not started) is not load.
  workCapacity: z
    .object({
      L: z.number().default(1),
      M: z.number().default(1),
      S: z.number().default(3),
    })
    .default({ L: 1, M: 1, S: 3 }),
  personalCapacity: z
    .object({
      L: z.number().default(1),
      M: z.number().default(1),
      S: z.number().default(2),
    })
    .default({ L: 1, M: 1, S: 2 }),
})
export type DashboardProfile = z.infer<typeof DashboardProfileSchema>

export const DashboardDataSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string().default("主面板"),
  goals: z.array(DashboardGoalSchema).default([]),
  metrics: z.array(DashboardMetricSchema).default([]),
  // Manual health log — coexists with the Apple Health bridge import.
  weightLog: z.array(WeightEntrySchema).default([]),
  mealLog: z.array(MealEntrySchema).default([]),
  exerciseLog: z.array(ExerciseEntrySchema).default([]),
  profile: DashboardProfileSchema.default({
    heightCm: 0,
    birthDate: "",
    sex: "",
    workCapacity: { L: 1, M: 1, S: 3 },
    personalCapacity: { L: 1, M: 1, S: 2 },
  }),
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
