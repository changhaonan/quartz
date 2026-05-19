// Dashboard widget i18n. All user-facing strings live here, in one table per
// locale, so the panel reads consistently in one language instead of the
// ad-hoc zh/en mix the renderer used to hardcode. The active locale is stored
// in data.json (DashboardData.locale) and switchable from the panel header.
//
// This is the widget's *own* string table — Quartz's quartz/i18n covers only
// Quartz core UI and has no dashboard keys.

import type { DashboardView, GoalCadence, GoalStatus, MealType } from "./schema"

export type DashLocale = "zh-CN" | "en-US"

export interface Strings {
  // --- header ---
  refresh: string
  updatedAt: (time: string) => string
  loadingAggregate: string
  aggError: (msg: string) => string
  saveFailed: (msg: string) => string

  // --- shared words (composed into option labels) ---
  word: { status: string; priority: string; tag: string; sort: string; all: string; none: string }

  // --- goals board ---
  goalsTitle: string
  cadence: Record<GoalCadence, string>
  addGoal: string
  noGoals: string
  noMatch: string
  untitledGoal: string
  goalTitlePlaceholder: string
  goalTitleAria: string
  notePlaceholder: string
  goalNoteAria: string
  removeGoal: string
  dragHint: string
  status: Record<GoalStatus, string>
  statusAria: string
  priority: Record<"high" | "mid" | "low", string>
  priorityAria: string
  priorityTag: (label: string) => string
  dueDateAria: string

  // tags
  tagAdd: string
  tagAddAria: string
  tagRemove: (tag: string) => string

  // progress log
  logLabel: string
  logAddPlaceholder: string
  logAddAria: string
  logEmpty: string
  logDelete: string

  // view toolbar
  filterStatusAria: string
  filterPriorityAria: string
  filterTagAria: string
  sortAria: string
  sortKey: Record<DashboardView["sort"], string>

  // --- health ---
  healthTitle: string
  healthError: (msg: string) => string
  healthLoading: string
  healthEmpty: string
  weight: string
  healthMetrics: { steps: string; sleepHours: string; restingHR: string }

  // --- health log (manual entry) ---
  weightToday: string
  weightInputAria: string
  removeWeight: string
  calorieTitle: string
  calorieToday: string
  calorieEmpty: string
  addMeal: string
  mealType: Record<MealType, string>
  mealTypeAria: string
  foodPlaceholder: string
  foodAria: string
  kcalAria: string
  estimateHint: string
  removeMeal: string

  // --- energy balance ---
  energyTitle: string
  energyNet: string
  energyIntake: string
  energyExpenditure: string
  energyBMR: string
  energyExercise: string
  energyDeficit: (n: string) => string
  energySurplus: (n: string) => string
  energyBalanced: string
  energyProjection: string
  energyEodPredict: (now: string) => string
  energy7dayAvg: string
  energyWeeklyDelta: (kg: string) => string
  energyBMRMissing: string
  energyExerciseImported: string

  // --- profile ---
  profileToggle: string
  profileHeight: string
  profileBirthDate: string
  profileSex: string
  profileSexValues: { male: string; female: string }

  // --- exercise log ---
  exerciseTitle: string
  exerciseEmpty: string
  addExercise: string
  exercisePlaceholder: string
  exerciseNameAria: string
  removeExercise: string

  // --- finance ---
  financeTitle: string
  financeParseError: (msg: string) => string
  financeNoData: string
  financeCash: string
  financeCredit: string
  financeNet: string
  financeControllable: string
  financeBudget: string
  financeCharges: string
  financeAlerts: string

  // --- custom metrics ---
  metricsTitle: string
  addMetric: string
  metricsEmpty: string
  removeMetric: string
  metricValueAria: string
  metricUnitPlaceholder: string
  metricUnitAria: string
  metricLabelPlaceholder: string
  metricLabelAria: string
  metricNoteAria: string

  // --- workflows ---
  workflowsTitle: string
  workflowsEmpty: string
  runCount: (n: number) => string

  // --- thoughts / diary ---
  thoughtsTitle: string
  thoughtsCount: (n: number) => string
  thoughtsEmpty: string

  // --- bridge ---
  bridgeTitle: string
  bridgeOnline: string
  bridgeOffline: string
  bridgeConnError: (origin: string, err: string) => string
  bridgeSessions: (n: number) => string
  bridgeTickets: (n: number) => string
  bridgeNoSessions: string
  bridgeNoTickets: string
}

const zhCN: Strings = {
  refresh: "刷新",
  updatedAt: (time) => `数据更新于 ${time}`,
  loadingAggregate: "加载聚合数据中…",
  aggError: (msg) => `聚合数据加载失败:${msg}(站点重建后会自动生成)。`,
  saveFailed: (msg) => `保存失败:${msg}`,

  word: { status: "状态", priority: "优先级", tag: "标签", sort: "排序", all: "全部", none: "无" },

  goalsTitle: "目标",
  cadence: { daily: "每日", weekly: "每周", main: "主要" },
  addGoal: "+ 添加",
  noGoals: "还没有目标。",
  noMatch: "无匹配目标",
  untitledGoal: "(未命名目标)",
  goalTitlePlaceholder: "目标标题…",
  goalTitleAria: "目标标题",
  notePlaceholder: "备注…",
  goalNoteAria: "目标备注",
  removeGoal: "删除目标",
  dragHint: "拖动以在列间移动",
  status: { todo: "未开始", doing: "进行中", done: "已完成" },
  statusAria: "状态",
  priority: { high: "高", mid: "中", low: "低" },
  priorityAria: "优先级",
  priorityTag: (label) => `${label}优先级`,
  dueDateAria: "截止日期",

  tagAdd: "+ 标签",
  tagAddAria: "添加标签",
  tagRemove: (tag) => `移除标签 ${tag}`,

  logLabel: "进展",
  logAddPlaceholder: "记录进展…",
  logAddAria: "记录进展",
  logEmpty: "还没有进展记录。",
  logDelete: "删除这条进展",

  filterStatusAria: "按状态筛选",
  filterPriorityAria: "按优先级筛选",
  filterTagAria: "按标签筛选",
  sortAria: "排序",
  sortKey: { manual: "手动", priority: "优先级", dueDate: "截止日期", status: "状态" },

  healthTitle: "健康",
  healthError: (msg) => `无法读取健康数据:${msg}。`,
  healthLoading: "加载健康数据中…",
  healthEmpty:
    "还没有健康数据。在 iPhone 上用「快捷指令」把体重等数据 POST 到 bridge 的 /api/metrics/health,刷新后即可在这里看到趋势。",
  weight: "体重",
  healthMetrics: { steps: "步数", sleepHours: "睡眠", restingHR: "静息心率" },

  weightToday: "今天",
  weightInputAria: "今天的体重(kg)",
  removeWeight: "清除今天的体重",
  calorieTitle: "卡路里",
  calorieToday: "今天",
  calorieEmpty: "今天还没有记录。",
  addMeal: "+ 添加一餐",
  mealType: { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" },
  mealTypeAria: "餐次",
  foodPlaceholder: "吃了什么…",
  foodAria: "食物",
  kcalAria: "卡路里(kcal)",
  estimateHint: "用 AI 估算卡路里",
  removeMeal: "删除这一餐",

  energyTitle: "能量收支",
  energyNet: "净差",
  energyIntake: "摄入",
  energyExpenditure: "消耗",
  energyBMR: "BMR",
  energyExercise: "运动",
  energyDeficit: (n) => `赤字 ${n} kcal`,
  energySurplus: (n) => `盈余 ${n} kcal`,
  energyBalanced: "持平",
  energyProjection: "预估",
  energyEodPredict: (now) => `现在 ${now},按节奏 EOD`,
  energy7dayAvg: "近 7 天均值",
  energyWeeklyDelta: (kg) => `≈ ${kg} kg / 周`,
  energyBMRMissing: "BMR 估算需要今日体重 + 下面的身高/出生年月/性别",
  energyExerciseImported: "Apple Health",

  profileToggle: "我的资料",
  profileHeight: "身高 (cm)",
  profileBirthDate: "出生年月",
  profileSex: "性别",
  profileSexValues: { male: "男", female: "女" },

  exerciseTitle: "运动",
  exerciseEmpty: "今天还没有运动记录。",
  addExercise: "+ 添加运动",
  exercisePlaceholder: "做了什么…",
  exerciseNameAria: "运动",
  removeExercise: "删除这一项",

  financeTitle: "财务",
  financeParseError: (msg) => `财务文件解析失败:${msg}`,
  financeNoData: "在 content/.finance/ 放一份周报 JSON 即可显示。",
  financeCash: "现金 + 存款",
  financeCredit: "信用卡欠款",
  financeNet: "净现金",
  financeControllable: "本周可控支出",
  financeBudget: "周预算达成",
  financeCharges: "即将到来的订阅",
  financeAlerts: "提醒",

  metricsTitle: "自定义指标",
  addMetric: "+ 添加指标",
  metricsEmpty: "还没有指标卡。",
  removeMetric: "删除指标",
  metricValueAria: "指标值",
  metricUnitPlaceholder: "单位",
  metricUnitAria: "单位",
  metricLabelPlaceholder: "指标名称",
  metricLabelAria: "指标名称",
  metricNoteAria: "指标备注",

  workflowsTitle: "工作流",
  workflowsEmpty: "未发现工作流。",
  runCount: (n) => `${n} 次运行`,

  thoughtsTitle: "想法 / 日记",
  thoughtsCount: (n) => `共 ${n} 条`,
  thoughtsEmpty: "暂无记录。",

  bridgeTitle: "Bridge",
  bridgeOnline: "在线",
  bridgeOffline: "离线",
  bridgeConnError: (origin, err) => `无法连接 bridge (${origin})${err ? ` — ${err}` : ""}。`,
  bridgeSessions: (n) => `会话 (${n})`,
  bridgeTickets: (n) => `工单 (${n})`,
  bridgeNoSessions: "无活跃会话",
  bridgeNoTickets: "无工单",
}

const enUS: Strings = {
  refresh: "Refresh",
  updatedAt: (time) => `Data updated ${time}`,
  loadingAggregate: "Loading aggregate data…",
  aggError: (msg) => `Aggregate data failed to load: ${msg} (regenerated on the next site build).`,
  saveFailed: (msg) => `Save failed: ${msg}`,

  word: {
    status: "Status",
    priority: "Priority",
    tag: "Tag",
    sort: "Sort",
    all: "All",
    none: "None",
  },

  goalsTitle: "Goals",
  cadence: { daily: "Daily", weekly: "Weekly", main: "Main" },
  addGoal: "+ Add",
  noGoals: "No goals yet.",
  noMatch: "No matching goals",
  untitledGoal: "(untitled goal)",
  goalTitlePlaceholder: "Goal title…",
  goalTitleAria: "Goal title",
  notePlaceholder: "Note…",
  goalNoteAria: "Goal note",
  removeGoal: "Delete goal",
  dragHint: "Drag to move between columns",
  status: { todo: "To do", doing: "In progress", done: "Done" },
  statusAria: "Status",
  priority: { high: "High", mid: "Medium", low: "Low" },
  priorityAria: "Priority",
  priorityTag: (label) => `${label} priority`,
  dueDateAria: "Due date",

  tagAdd: "+ Tag",
  tagAddAria: "Add tag",
  tagRemove: (tag) => `Remove tag ${tag}`,

  logLabel: "Progress",
  logAddPlaceholder: "Log progress…",
  logAddAria: "Log progress",
  logEmpty: "No progress entries yet.",
  logDelete: "Delete this entry",

  filterStatusAria: "Filter by status",
  filterPriorityAria: "Filter by priority",
  filterTagAria: "Filter by tag",
  sortAria: "Sort",
  sortKey: { manual: "Manual", priority: "Priority", dueDate: "Due date", status: "Status" },

  healthTitle: "Health",
  healthError: (msg) => `Cannot read health data: ${msg}.`,
  healthLoading: "Loading health data…",
  healthEmpty:
    "No health data yet. On iPhone, use a Shortcut to POST weight and other samples to the bridge at /api/metrics/health, then refresh to see trends here.",
  weight: "Weight",
  healthMetrics: { steps: "Steps", sleepHours: "Sleep", restingHR: "Resting HR" },

  weightToday: "Today",
  weightInputAria: "Today's weight (kg)",
  removeWeight: "Clear today's weight",
  calorieTitle: "Calories",
  calorieToday: "Today",
  calorieEmpty: "Nothing logged today.",
  addMeal: "+ Add meal",
  mealType: { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" },
  mealTypeAria: "Meal",
  foodPlaceholder: "What did you eat…",
  foodAria: "Food",
  kcalAria: "Calories (kcal)",
  estimateHint: "Estimate calories with AI",
  removeMeal: "Delete this meal",

  energyTitle: "Energy balance",
  energyNet: "Net",
  energyIntake: "Intake",
  energyExpenditure: "Expenditure",
  energyBMR: "BMR",
  energyExercise: "Exercise",
  energyDeficit: (n) => `${n} kcal deficit`,
  energySurplus: (n) => `${n} kcal surplus`,
  energyBalanced: "Balanced",
  energyProjection: "Projection",
  energyEodPredict: (now) => `Now ${now}, projected EOD`,
  energy7dayAvg: "7-day average",
  energyWeeklyDelta: (kg) => `≈ ${kg} kg/week`,
  energyBMRMissing: "BMR needs today's weight + the height/birth date/sex below",
  energyExerciseImported: "Apple Health",

  profileToggle: "My profile",
  profileHeight: "Height (cm)",
  profileBirthDate: "Birth date",
  profileSex: "Sex",
  profileSexValues: { male: "Male", female: "Female" },

  exerciseTitle: "Exercise",
  exerciseEmpty: "No exercise logged today.",
  addExercise: "+ Add exercise",
  exercisePlaceholder: "What did you do…",
  exerciseNameAria: "Exercise",
  removeExercise: "Delete this entry",

  financeTitle: "Finance",
  financeParseError: (msg) => `Finance file failed to parse: ${msg}`,
  financeNoData: "Drop a weekly report JSON into content/.finance/ to show finance here.",
  financeCash: "Cash + deposits",
  financeCredit: "Credit card debt",
  financeNet: "Net cash",
  financeControllable: "Controllable spend this week",
  financeBudget: "Weekly budget progress",
  financeCharges: "Upcoming subscriptions",
  financeAlerts: "Alerts",

  metricsTitle: "Custom metrics",
  addMetric: "+ Add metric",
  metricsEmpty: "No metric cards yet.",
  removeMetric: "Delete metric",
  metricValueAria: "Metric value",
  metricUnitPlaceholder: "Unit",
  metricUnitAria: "Unit",
  metricLabelPlaceholder: "Metric name",
  metricLabelAria: "Metric name",
  metricNoteAria: "Metric note",

  workflowsTitle: "Workflows",
  workflowsEmpty: "No workflows found.",
  runCount: (n) => `${n} run${n === 1 ? "" : "s"}`,

  thoughtsTitle: "Thoughts / Diary",
  thoughtsCount: (n) => `${n} total`,
  thoughtsEmpty: "Nothing recorded yet.",

  bridgeTitle: "Bridge",
  bridgeOnline: "online",
  bridgeOffline: "offline",
  bridgeConnError: (origin, err) => `Cannot reach bridge (${origin})${err ? ` — ${err}` : ""}.`,
  bridgeSessions: (n) => `Sessions (${n})`,
  bridgeTickets: (n) => `Tickets (${n})`,
  bridgeNoSessions: "No active sessions",
  bridgeNoTickets: "No tickets",
}

const TABLES: Record<DashLocale, Strings> = { "zh-CN": zhCN, "en-US": enUS }

// Resolve a locale string to its table; unknown locales fall back to zh-CN
// (the panel is Chinese-first).
export function getStrings(locale: string): Strings {
  return TABLES[locale as DashLocale] ?? zhCN
}
