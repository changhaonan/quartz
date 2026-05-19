/** @jsxRuntime classic */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { createRoot, type Root } from "react-dom/client"
import type { JsonPatchOp, WidgetMountContext } from "../types"
import type {
  DashboardData,
  DashboardGoal,
  DashboardMetric,
  DashboardProfile,
  DashboardView,
  ExerciseEntry,
  GoalCadence,
  GoalLogEntry,
  GoalPriority,
  GoalStatus,
  MealEntry,
  MealType,
  WeightEntry,
} from "./schema"
import { MEAL_TYPES } from "./schema"
import { getStrings, type DashLocale, type Strings } from "./i18n"

// ---------------------------------------------------------------------------
// All user-facing text comes from the i18n table via this context, so the
// panel renders consistently in one language. The Dashboard root provides it;
// every component reads it with useStrings().
// ---------------------------------------------------------------------------
const StringsContext = createContext<Strings>(getStrings("zh-CN"))
const useStrings = (): Strings => useContext(StringsContext)

// The display locale is global, not per-panel: the chrome's language toggle
// (language.inline.ts) keeps it on <html data-lang> and broadcasts a
// `langchange` event. The dashboard reads it on mount and re-renders on change.
function readGlobalLocale(): DashLocale {
  const v =
    typeof document !== "undefined" ? document.documentElement.getAttribute("data-lang") : null
  return v === "en-US" || v === "zh-CN" ? v : "zh-CN"
}

// ---------------------------------------------------------------------------
// Aggregate shape — mirrors quartz/plugins/emitters/dashboardAggregate.ts.
// Kept structural/loose: the panel renders defensively so a missing or
// malformed section degrades gracefully instead of throwing.
// ---------------------------------------------------------------------------
interface Aggregate {
  generatedAt?: string
  finance?: { file?: string | null; data?: any; error?: string | null }
  workflows?: Array<{
    name: string
    slug: string
    runCount: number
    latestRunId: string | null
    latestStatus: string | null
  }>
  thoughts?: { total?: number; recent?: Array<{ title: string; slug: string; mtime: string }> }
  bridge?: {
    ok?: boolean
    origin?: string
    error?: string | null
    sessions?: any[]
    tickets?: any[]
  }
}

function money(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n)) return "—"
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return ""
  // A bare YYYY-MM-DD parses as UTC midnight; toLocaleDateString then
  // shifts it to the previous day in negative-UTC zones. Build the
  // Date locally to preserve the intended calendar day.
  const ymd = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const d = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(iso)
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-CA")
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// Compact local timestamp for a progress-log entry, e.g. "05-17 15:30".
function fmtLogTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Today as a local YYYY-MM-DD string — the key health-log entries are filed
// under (and the same date form the iOS Shortcut uses for imported samples).
function todayISO(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// N days ago as a local YYYY-MM-DD.
function daysAgoISO(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Fractional hour of the local day (0..24). EOD projection scales today's
// values by 24/h.
function hourOfDay(): number {
  const d = new Date()
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
}

function formatNowHHMM(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function ageFromBirthDate(iso: string): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - d.getFullYear()
  const beforeBirthday =
    today.getMonth() < d.getMonth() ||
    (today.getMonth() === d.getMonth() && today.getDate() < d.getDate())
  if (beforeBirthday) age--
  return age >= 0 && age < 130 ? age : null
}

// Mifflin-St Jeor BMR. Returns null if profile incomplete or weight unknown.
function computeBMR(profile: DashboardProfile, weightKg: number | null): number | null {
  if (!profile.heightCm || profile.heightCm <= 0) return null
  if (profile.sex !== "male" && profile.sex !== "female") return null
  if (weightKg == null || weightKg <= 0) return null
  const age = ageFromBirthDate(profile.birthDate)
  if (age == null) return null
  const base = 10 * weightKg + 6.25 * profile.heightCm - 5 * age
  return Math.round(profile.sex === "male" ? base + 5 : base - 161)
}

function sumKcalOnDate(rows: Array<{ date: string; kcal: number }>, date: string): number {
  let s = 0
  for (const r of rows) if (r.date === date) s += Number.isFinite(r.kcal) ? r.kcal : 0
  return s
}

function activeEnergyOnDate(samples: HealthSample[] | null, date: string): number {
  if (!samples) return 0
  for (const s of samples) {
    if (s.date === date && typeof s.activeEnergy === "number") return s.activeEnergy
  }
  return 0
}

// One AI-estimate helper, used by both food and exercise rows. The
// `intent` switches the bridge's prompt; `context` is an optional hint
// (meal slot for food, intensity-y phrase for exercise).
type EstimateKcalFn = (
  description: string,
  intent: "food" | "exercise",
  context?: string,
) => Promise<number | null>

// Compact "LABEL value" pill, used in each section's summary row at the
// top — so the panel reads as a glance even before scanning the cards.
function SummaryPill(props: {
  label: string
  value: React.ReactNode
  tone?: "good" | "warn" | "muted"
}) {
  const tone = props.tone ? ` dash-summary__pill--${props.tone}` : ""
  return (
    <div className={`dash-summary__pill${tone}`}>
      <span className="dash-summary__label">{props.label}</span>
      <span className="dash-summary__value">{props.value}</span>
    </div>
  )
}

// A goal counts as "work" iff one of its tags matches WORK_TAGS (case-
// insensitive on the latin ones). Everything else falls into "personal".
const WORK_TAGS = new Set(["work", "工作", "office", "job"])
function isWorkGoal(g: DashboardGoal): boolean {
  return g.tags.some((t) => WORK_TAGS.has(t.toLowerCase()))
}

// Parse a free-text time estimate into integer minutes. "45m" / "2h" /
// "1.5h" / "2d" supported; a bare number defaults to hours. Returns 0
// on parse failure or non-positive input (which clears the field).
function parseTimeInput(s: string): number {
  const t = s.trim().toLowerCase()
  if (!t) return 0
  const m = t.match(/^([\d.]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!isFinite(n) || n < 0) return 0
  const unit = m[2] || "h"
  if (unit.startsWith("m") && unit !== "h") return Math.round(n)
  if (unit.startsWith("d")) return Math.round(n * 8 * 60) // workday = 8h
  return Math.round(n * 60)
}

// Render minutes back to a compact string. <60 → "45m"; whole hours →
// "2h"; fractional → "1.5h". Empty / 0 → "".
function formatMinutes(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return ""
  if (min < 60) return `${Math.round(min)}m`
  const h = min / 60
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`
}

// ---------------------------------------------------------------------------
// EditableField — an in-place text field that reads as plain text until the
// user clicks into it (no popup, no separate "edit mode"). The same pattern
// the block-page editor uses: a borderless input that gets a soft fill on
// hover/focus. The edit is committed on blur or Enter; Escape reverts. While
// typing, only this component's local buffer changes, so keystrokes stay
// snappy and the parent (and its write) fire just once, on commit.
// ---------------------------------------------------------------------------
function EditableField(props: {
  value: string
  placeholder?: string
  className?: string
  ariaLabel?: string
  // Focus + select on mount — used for the row a "+ add" click just created
  // so the user can immediately type instead of hunting for the input.
  focusOnMount?: boolean
  onCommit: (value: string) => void
}) {
  const { value, placeholder, className, ariaLabel, focusOnMount } = props
  const [buf, setBuf] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  // Re-sync when the canonical value changes underneath us (external refresh,
  // a rolled-back failed write). Doesn't clobber in-progress typing: an
  // unchanged `value` prop means this effect doesn't run.
  useEffect(() => {
    setBuf(value)
  }, [value])

  useEffect(() => {
    if (focusOnMount && ref.current) {
      ref.current.focus()
      ref.current.select()
    }
  }, [focusOnMount])

  return (
    <input
      ref={ref}
      className={`dash-edit${className ? ` ${className}` : ""}`}
      type="text"
      value={buf}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setBuf(e.currentTarget.value)}
      onBlur={() => {
        if (buf !== value) props.onCommit(buf)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === "Escape") {
          setBuf(value)
          // blur on the next tick so the reverted buffer is in place first.
          window.setTimeout(() => ref.current?.blur(), 0)
        }
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Goals — a Notion-style board. Each cadence (daily / weekly / main) is a
// column; each goal is a card. Editing is in-place; a card is dragged between
// columns to change its cadence (the only way to re-bucket a goal).
// ---------------------------------------------------------------------------
const GOAL_CADENCES: GoalCadence[] = ["daily", "weekly", "main"]

// Where a drag is currently pointing: a column, and the card it would land
// before (null = end of the column).
interface DropTarget {
  cadence: GoalCadence
  beforeId: string | null
}

// Move `id` to `cadence`, inserting before `beforeId` (or at the column's end
// when null). Goals of different cadences interleave freely in the array — the
// per-column filter preserves relative order, so splicing before `beforeId`
// lands the card exactly where the drop indicator showed it.
function moveGoal(
  goals: DashboardGoal[],
  id: string,
  cadence: GoalCadence,
  beforeId: string | null,
): DashboardGoal[] {
  const dragged = goals.find((g) => g.id === id)
  if (!dragged) return goals
  const rest = goals.filter((g) => g.id !== id)
  const moved: DashboardGoal = { ...dragged, cadence }
  const idx = beforeId ? rest.findIndex((g) => g.id === beforeId) : -1
  if (idx < 0) rest.push(moved)
  else rest.splice(idx, 0, moved)
  return rest
}

// --- Card property controls (Notion-database style) ------------------------
const STATUS_VALUES: GoalStatus[] = ["todo", "doing", "done"]
// Priority select order: "none" first (acts as the placeholder), then high→low.
const PRIORITY_VALUES: GoalPriority[] = ["none", "high", "mid", "low"]
const SORT_VALUES: DashboardView["sort"][] = ["manual", "priority", "dueDate", "status"]

// --- Board view: filtering + sorting ---------------------------------------
// Sort ranks. Status: active work first, done last. Priority: high first.
const STATUS_RANK: Record<GoalStatus, number> = { doing: 0, todo: 1, done: 2 }
const PRIORITY_RANK: Record<GoalPriority, number> = { high: 0, mid: 1, low: 2, none: 3 }

function matchesView(g: DashboardGoal, v: DashboardView): boolean {
  if (v.filterStatus !== "all" && g.status !== v.filterStatus) return false
  if (v.filterPriority !== "all" && g.priority !== v.filterPriority) return false
  if (v.filterTag !== "" && !g.tags.includes(v.filterTag)) return false
  return true
}

// Sort a column's goals by the active key. "manual" keeps array (drag) order;
// any other key is a stable sort that falls back to array order on ties.
function sortGoals(goals: DashboardGoal[], sort: DashboardView["sort"]): DashboardGoal[] {
  if (sort === "manual") return goals
  return goals
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      let d = 0
      if (sort === "priority") d = PRIORITY_RANK[a.g.priority] - PRIORITY_RANK[b.g.priority]
      else if (sort === "status") d = STATUS_RANK[a.g.status] - STATUS_RANK[b.g.status]
      else if (sort === "dueDate") {
        // ISO dates compare lexically; empty (unset) sorts last.
        const av = a.g.dueDate || "9999-12-31"
        const bv = b.g.dueDate || "9999-12-31"
        d = av < bv ? -1 : av > bv ? 1 : 0
      }
      return d !== 0 ? d : a.i - b.i
    })
    .map((k) => k.g)
}

// Status — the goal's coarse progress. A segmented control when editable, a
// single pill when read-only.
function StatusControl(props: {
  status: GoalStatus
  canWrite: boolean
  onChange: (s: GoalStatus) => void
}) {
  const t = useStrings()
  const { status, canWrite } = props
  if (!canWrite) {
    return <span className={`dash-statpill dash-statpill--${status}`}>{t.status[status]}</span>
  }
  return (
    <div className="dash-seg" role="group" aria-label={t.statusAria}>
      {STATUS_VALUES.map((v) => (
        <button
          key={v}
          type="button"
          data-status={v}
          className={`dash-seg__btn dash-seg__btn--${v}${status === v ? " is-active" : ""}`}
          onClick={() => props.onChange(v)}
        >
          {t.status[v]}
        </button>
      ))}
    </div>
  )
}

// Tags — a wrapping row of chips with an inline add-input. Enter / blur commits
// the typed tag; Backspace on an empty input removes the last chip.
function TagEditor(props: {
  tags: string[]
  canWrite: boolean
  onChange: (tags: string[]) => void
}) {
  const t = useStrings()
  const { tags, canWrite } = props
  const [input, setInput] = useState("")
  if (!canWrite) {
    if (tags.length === 0) return null
    return (
      <div className="dash-tags">
        {tags.map((tag) => (
          <span className="dash-tag-chip" key={tag}>
            #{tag}
          </span>
        ))}
      </div>
    )
  }
  const add = () => {
    const v = input.trim()
    if (v && !tags.includes(v)) props.onChange([...tags, v])
    setInput("")
  }
  return (
    <div className="dash-tags">
      {tags.map((tag) => (
        <span className="dash-tag-chip" key={tag}>
          #{tag}
          <button
            type="button"
            className="dash-tag-chip__x"
            aria-label={t.tagRemove(tag)}
            onClick={() => props.onChange(tags.filter((x) => x !== tag))}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        className="dash-tag-input"
        value={input}
        placeholder={t.tagAdd}
        aria-label={t.tagAddAria}
        onChange={(e) => setInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            add()
          } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
            props.onChange(tags.slice(0, -1))
          }
        }}
        onBlur={add}
      />
    </div>
  )
}

// Progress timeline — a collapsible log of timestamped notes. Collapsed by
// default (just a "Progress N" toggle) so cards stay compact; expand to read
// the history or append an entry.
function GoalLog(props: {
  entries: GoalLogEntry[]
  canWrite: boolean
  onChange: (entries: GoalLogEntry[]) => void
}) {
  const t = useStrings()
  const { entries, canWrite } = props
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")

  // Read-only viewer with no history — nothing to show.
  if (!canWrite && entries.length === 0) return null

  const addEntry = () => {
    const text = draft.trim()
    if (!text) return
    props.onChange([...entries, { at: new Date().toISOString(), text }])
    setDraft("")
  }
  const removeEntry = (idx: number) => props.onChange(entries.filter((_, i) => i !== idx))

  return (
    <div className="dash-gcard__log">
      <button
        type="button"
        className={`dash-log-toggle${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dash-log-toggle__caret" aria-hidden="true" />
        {t.logLabel}
        {entries.length > 0 ? ` ${entries.length}` : ""}
      </button>
      {open && (
        <div className="dash-log-body">
          {canWrite && (
            <input
              className="dash-log-add"
              value={draft}
              placeholder={t.logAddPlaceholder}
              aria-label={t.logAddAria}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addEntry()
                }
              }}
              onBlur={addEntry}
            />
          )}
          {entries.length === 0 ? (
            <p className="dash-log-empty">{t.logEmpty}</p>
          ) : (
            <ul className="dash-log-list">
              {/* oldest-first in storage; show newest-first */}
              {entries
                .map((entry, idx) => ({ entry, idx }))
                .reverse()
                .map(({ entry, idx }) => (
                  <li className="dash-log-entry" key={`${entry.at}-${idx}`}>
                    <span className="dash-log-entry__time">{fmtLogTime(entry.at)}</span>
                    <span className="dash-log-entry__text">{entry.text}</span>
                    {canWrite && (
                      <button
                        type="button"
                        className="dash-log-entry__x"
                        aria-label={t.logDelete}
                        onClick={() => removeEntry(idx)}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// --- One goal card ---------------------------------------------------------
function GoalCard(props: {
  goal: DashboardGoal
  canWrite: boolean
  dragging: boolean
  focus: boolean
  estimateTaskTime: ((title: string, note: string) => Promise<number | null>) | null
  onPatch: (partial: Partial<DashboardGoal>) => void
  onRemove: () => void
  onDragStart: () => void
  onDragEnd: () => void
  // Cursor moved over this card during a drag — reports whether the drop would
  // land before this card or before the next one.
  onDragOver: (before: boolean) => void
}) {
  const t = useStrings()
  const { goal: g, canWrite, dragging, focus } = props
  const cardRef = useRef<HTMLDivElement>(null)
  const [estimatingTime, setEstimatingTime] = useState(false)
  const showProps =
    canWrite || g.priority !== "none" || Boolean(g.dueDate) || g.estimatedMinutes > 0

  const runTimeEstimate = async () => {
    const title = g.title.trim()
    if (estimatingTime || !props.estimateTaskTime || !title) return
    setEstimatingTime(true)
    try {
      const min = await props.estimateTaskTime(title, g.note)
      if (min != null && min > 0) props.onPatch({ estimatedMinutes: min })
    } finally {
      setEstimatingTime(false)
    }
  }

  return (
    <div
      ref={cardRef}
      className={`dash-gcard${g.status === "done" ? " is-done" : ""}${
        dragging ? " is-dragging" : ""
      }`}
      data-goal-id={g.id}
      onDragOver={
        canWrite
          ? (e) => {
              e.preventDefault()
              e.stopPropagation() // keep the column handler from overriding us
              const r = e.currentTarget.getBoundingClientRect()
              props.onDragOver(e.clientY < r.top + r.height / 2)
            }
          : undefined
      }
    >
      {canWrite && (
        <span
          className="dash-gcard__grip"
          title={t.dragHint}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move"
            if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 12, 12)
            props.onDragStart()
          }}
          onDragEnd={props.onDragEnd}
        >
          ⠿
        </span>
      )}
      <div className="dash-gcard__main">
        <div className="dash-gcard__head">
          {canWrite ? (
            <EditableField
              className="dash-gcard__title-input"
              value={g.title}
              placeholder={t.goalTitlePlaceholder}
              ariaLabel={t.goalTitleAria}
              focusOnMount={focus}
              onCommit={(title) => props.onPatch({ title })}
            />
          ) : (
            <span className="dash-gcard__title">{g.title || t.untitledGoal}</span>
          )}
          {canWrite && (
            <button className="dash-gcard__remove" title={t.removeGoal} onClick={props.onRemove}>
              ✕
            </button>
          )}
        </div>

        {canWrite ? (
          <EditableField
            className="dash-gcard__note-input"
            value={g.note}
            placeholder={t.notePlaceholder}
            ariaLabel={t.goalNoteAria}
            onCommit={(note) => props.onPatch({ note })}
          />
        ) : (
          g.note && <div className="dash-gcard__note">{g.note}</div>
        )}

        <StatusControl
          status={g.status}
          canWrite={canWrite}
          onChange={(status) => props.onPatch({ status })}
        />

        {showProps && (
          <div className="dash-gcard__props">
            {canWrite ? (
              <select
                className={`dash-prio dash-prio--${g.priority}`}
                value={g.priority}
                aria-label={t.priorityAria}
                onChange={(e) => props.onPatch({ priority: e.currentTarget.value as GoalPriority })}
              >
                {PRIORITY_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {v === "none" ? t.word.priority : `${t.word.priority} · ${t.priority[v]}`}
                  </option>
                ))}
              </select>
            ) : (
              g.priority !== "none" && (
                <span className={`dash-priopill dash-priopill--${g.priority}`}>
                  {t.priorityTag(t.priority[g.priority])}
                </span>
              )
            )}
            {canWrite ? (
              <input
                className={`dash-date${g.dueDate ? " has-value" : ""}`}
                type="date"
                value={g.dueDate}
                aria-label={t.dueDateAria}
                onChange={(e) => props.onPatch({ dueDate: e.currentTarget.value })}
              />
            ) : (
              g.dueDate && <span className="dash-duepill">📅 {g.dueDate}</span>
            )}
            {canWrite ? (
              <span className="dash-est">
                <EditableField
                  className="dash-est__input"
                  value={formatMinutes(g.estimatedMinutes)}
                  placeholder={t.estimatePlaceholder}
                  ariaLabel={t.estimateAria}
                  onCommit={(v) => props.onPatch({ estimatedMinutes: parseTimeInput(v) })}
                />
                {props.estimateTaskTime && (
                  <button
                    type="button"
                    className="dash-est__ai"
                    title={t.estimateAIHint}
                    aria-label={t.estimateAIHint}
                    disabled={estimatingTime || g.title.trim() === ""}
                    onClick={runTimeEstimate}
                  >
                    {estimatingTime ? "⋯" : "✨"}
                  </button>
                )}
              </span>
            ) : (
              g.estimatedMinutes > 0 && (
                <span className="dash-estpill">⏱ {formatMinutes(g.estimatedMinutes)}</span>
              )
            )}
          </div>
        )}

        <TagEditor tags={g.tags} canWrite={canWrite} onChange={(tags) => props.onPatch({ tags })} />

        <GoalLog entries={g.log} canWrite={canWrite} onChange={(log) => props.onPatch({ log })} />
      </div>
    </div>
  )
}

// --- One board column ------------------------------------------------------
function GoalColumn(props: {
  cadence: GoalCadence
  rows: DashboardGoal[]
  canWrite: boolean
  // When a sort is active, within-column position is sort-determined: a drop
  // means "this column", so we suppress the between-cards drop indicator.
  sorted: boolean
  filterActive: boolean
  draggingId: string | null
  focusGoalId: string | null
  drop: DropTarget | null
  estimateTaskTime: ((title: string, note: string) => Promise<number | null>) | null
  onCardPatch: (id: string, partial: Partial<DashboardGoal>) => void
  onRemove: (id: string) => void
  onAdd: (cadence: GoalCadence) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDropHint: (target: DropTarget) => void
  onDrop: () => void
}) {
  const t = useStrings()
  const { cadence, rows, canWrite, sorted, draggingId, focusGoalId, drop } = props
  const isActive = drop?.cadence === cadence
  const dropLine = (beforeId: string | null) =>
    !sorted && isActive && drop?.beforeId === beforeId ? <div className="dash-drop-line" /> : null

  return (
    <div
      className={`dash-col${isActive ? " is-droptarget" : ""}`}
      onDragOver={
        canWrite
          ? (e) => {
              e.preventDefault()
              // Bare column area (below the cards) — drop at the end.
              props.onDropHint({ cadence, beforeId: null })
            }
          : undefined
      }
      onDrop={
        canWrite
          ? (e) => {
              e.preventDefault()
              props.onDrop()
            }
          : undefined
      }
    >
      <div className="dash-col__head">
        <span className="dash-col__title">{t.cadence[cadence]}</span>
        <span className="dash-col__count">{rows.length}</span>
      </div>
      <div className="dash-col__body">
        {rows.map((g, i) => (
          <React.Fragment key={g.id}>
            {dropLine(g.id)}
            <GoalCard
              goal={g}
              canWrite={canWrite}
              dragging={draggingId === g.id}
              focus={focusGoalId === g.id}
              estimateTaskTime={props.estimateTaskTime}
              onPatch={(partial) => props.onCardPatch(g.id, partial)}
              onRemove={() => props.onRemove(g.id)}
              onDragStart={() => props.onDragStart(g.id)}
              onDragEnd={props.onDragEnd}
              onDragOver={(before) =>
                props.onDropHint({
                  cadence,
                  // Sorted: position is not user-controlled — drop = column.
                  beforeId: sorted ? null : before ? g.id : (rows[i + 1]?.id ?? null),
                })
              }
            />
          </React.Fragment>
        ))}
        {dropLine(null)}
        {rows.length === 0 &&
          (props.filterActive ? (
            <p className="dash-empty">{t.noMatch}</p>
          ) : (
            !canWrite && <p className="dash-empty">{t.noGoals}</p>
          ))}
      </div>
      {canWrite && (
        <button className="dash-col__add" onClick={() => props.onAdd(cadence)}>
          {t.addGoal}
        </button>
      )}
    </div>
  )
}

function GoalsSection(props: {
  goals: DashboardGoal[]
  view: DashboardView
  canWrite: boolean
  focusGoalId: string | null
  estimateTaskTime: ((title: string, note: string) => Promise<number | null>) | null
  // Mutate the goals array and persist.
  setGoals: (mutate: (goals: DashboardGoal[]) => DashboardGoal[]) => void
  // Patch the persisted view (filter / sort) state.
  setView: (partial: Partial<DashboardView>) => void
  onAddGoal: (cadence: GoalCadence) => void
}) {
  const t = useStrings()
  const { goals, view, canWrite, focusGoalId } = props
  // Drag state lives in refs (read synchronously by the drop handler — the
  // native `drop` event fires right after `dragover`, before React would have
  // re-rendered) and is mirrored to state purely for visual feedback.
  const dragIdRef = useRef<string | null>(null)
  const dropRef = useRef<DropTarget | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)

  const patchGoal = (id: string, partial: Partial<DashboardGoal>) =>
    props.setGoals((gs) => gs.map((g) => (g.id === id ? { ...g, ...partial } : g)))
  const removeGoal = (id: string) => props.setGoals((gs) => gs.filter((g) => g.id !== id))

  const startDrag = (id: string) => {
    dragIdRef.current = id
    setDraggingId(id)
  }
  const hintDrop = (target: DropTarget) => {
    dropRef.current = target
    setDrop(target)
  }
  const endDrag = () => {
    dragIdRef.current = null
    dropRef.current = null
    setDraggingId(null)
    setDrop(null)
  }
  const handleDrop = () => {
    const id = dragIdRef.current
    const target = dropRef.current
    if (id && target) props.setGoals((gs) => moveGoal(gs, id, target.cadence, target.beforeId))
    endDrag()
  }

  // Tags present across all goals — populates the tag-filter dropdown.
  const allTags = [...new Set(goals.flatMap((g) => g.tags))].sort()
  const filterActive =
    view.filterStatus !== "all" || view.filterPriority !== "all" || view.filterTag !== ""
  const visible = goals.filter((g) => matchesView(g, view))

  // Summary pills: active workload split work / personal, plus overdue %
  // of dated active goals. "Done" goals drop out; "main" / "weekly" /
  // "daily" cadence is irrelevant here.
  const today = todayISO()
  const activeGoals = goals.filter((g) => g.status !== "done")
  const workActive = activeGoals.filter(isWorkGoal).length
  const personalActive = activeGoals.length - workActive
  const withDue = activeGoals.filter((g) => g.dueDate)
  const overdueCount = withDue.filter((g) => g.dueDate < today).length
  const overdueRate = withDue.length > 0 ? Math.round((overdueCount / withDue.length) * 100) : 0

  return (
    <section className="dash-section">
      <div className="dash-section__head dash-section__head--board">
        <h2>{t.goalsTitle}</h2>
        {canWrite && (
          <div className="dash-board-toolbar">
            <select
              className="dash-vselect"
              aria-label={t.filterStatusAria}
              value={view.filterStatus}
              onChange={(e) =>
                props.setView({
                  filterStatus: e.currentTarget.value as DashboardView["filterStatus"],
                })
              }
            >
              <option value="all">{`${t.word.status} · ${t.word.all}`}</option>
              {STATUS_VALUES.map((v) => (
                <option key={v} value={v}>{`${t.word.status} · ${t.status[v]}`}</option>
              ))}
            </select>
            <select
              className="dash-vselect"
              aria-label={t.filterPriorityAria}
              value={view.filterPriority}
              onChange={(e) =>
                props.setView({
                  filterPriority: e.currentTarget.value as DashboardView["filterPriority"],
                })
              }
            >
              <option value="all">{`${t.word.priority} · ${t.word.all}`}</option>
              <option value="high">{`${t.word.priority} · ${t.priority.high}`}</option>
              <option value="mid">{`${t.word.priority} · ${t.priority.mid}`}</option>
              <option value="low">{`${t.word.priority} · ${t.priority.low}`}</option>
              <option value="none">{`${t.word.priority} · ${t.word.none}`}</option>
            </select>
            <select
              className="dash-vselect"
              aria-label={t.filterTagAria}
              value={view.filterTag}
              onChange={(e) => props.setView({ filterTag: e.currentTarget.value })}
            >
              <option value="">{`${t.word.tag} · ${t.word.all}`}</option>
              {/* A previously-set tag filter may no longer exist on any goal;
                  keep it as an option so the select still shows it. */}
              {!allTags.includes(view.filterTag) && view.filterTag !== "" && (
                <option value={view.filterTag}>{`${t.word.tag} · #${view.filterTag}`}</option>
              )}
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{`${t.word.tag} · #${tag}`}</option>
              ))}
            </select>
            <select
              className="dash-vselect"
              aria-label={t.sortAria}
              value={view.sort}
              onChange={(e) =>
                props.setView({ sort: e.currentTarget.value as DashboardView["sort"] })
              }
            >
              {SORT_VALUES.map((v) => (
                <option key={v} value={v}>{`${t.word.sort} · ${t.sortKey[v]}`}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="dash-summary">
        <SummaryPill label={t.summaryWork} value={workActive} />
        <SummaryPill label={t.summaryPersonal} value={personalActive} />
        <SummaryPill
          label={t.summaryOverdue}
          value={`${overdueRate}%`}
          tone={overdueCount > 0 ? "warn" : undefined}
        />
      </div>
      <div className="dash-board">
        {GOAL_CADENCES.map((cadence) => (
          <GoalColumn
            key={cadence}
            cadence={cadence}
            rows={sortGoals(
              visible.filter((g) => (g.cadence ?? "main") === cadence),
              view.sort,
            )}
            canWrite={canWrite}
            sorted={view.sort !== "manual"}
            filterActive={filterActive}
            draggingId={draggingId}
            focusGoalId={focusGoalId}
            drop={drop}
            estimateTaskTime={props.estimateTaskTime}
            onCardPatch={patchGoal}
            onRemove={removeGoal}
            onAdd={props.onAddGoal}
            onDragStart={startDrag}
            onDragEnd={endDrag}
            onDropHint={hintDrop}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Health — live Apple Health metrics, pushed from an iOS Shortcut to the
// bridge (POST /api/metrics/health) and fetched back here for the charts.
// ---------------------------------------------------------------------------
interface HealthSample {
  date: string
  weight?: number
  steps?: number
  sleepHours?: number
  restingHR?: number
  // Energy fields — populated by the iOS Shortcut when it POSTs Apple
  // Health's "Active Energy" and "Resting Energy" alongside the others.
  activeEnergy?: number
  restingEnergy?: number
}

const HEALTH_MINI_METRICS: Array<{
  key: "steps" | "sleepHours" | "restingHR"
  unit: string
  digits: number
}> = [
  { key: "steps", unit: "", digits: 0 },
  { key: "sleepHours", unit: "h", digits: 1 },
  { key: "restingHR", unit: "bpm", digits: 0 },
]

const r1 = (n: number): number => Math.round(n * 10) / 10

// Catmull-Rom → cubic-bezier: a smooth curve through every point, with no
// overshoot surprises on the sparse, irregular series a personal tracker
// produces.
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 3) {
    return pts.map((p, i) => `${i ? "L" : "M"} ${r1(p.x)} ${r1(p.y)}`).join(" ")
  }
  let d = `M ${r1(pts[0].x)} ${r1(pts[0].y)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${r1(c1x)} ${r1(c1y)} ${r1(c2x)} ${r1(c2y)} ${r1(p2.x)} ${r1(p2.y)}`
  }
  return d
}

// Inline SVG line/area chart — no charting dependency. Stretches to its
// container width (preserveAspectRatio="none") with a non-scaling stroke so
// the line stays crisp at any size; colour tracks the theme via currentColor.
function TrendChart(props: { values: number[]; height: number; fill?: boolean }) {
  const gradId = useId()
  const { values, height, fill } = props
  const W = 300
  const H = height
  const pad = 4
  // No data → don't reserve dead space.
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const n = values.length
  const pts = values.map((v, i) => ({
    x: pad + (i / (n - 1)) * (W - pad * 2),
    y: pad + (1 - (v - min) / span) * (H - pad * 2),
  }))
  const line = smoothPath(pts)
  return (
    <svg
      className="dash-chart"
      style={{ height }}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {fill && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {fill && (
        <path
          d={`${line} L ${r1(pts[n - 1].x)} ${H} L ${r1(pts[0].x)} ${H} Z`}
          fill={`url(#${gradId})`}
          stroke="none"
        />
      )}
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={fill ? 2.25 : 1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// Merge Apple-Health imported weights with manually-logged ones into one
// date-ordered series. A manual entry wins for its date — so a correction, or
// a day the phone didn't push, still lands on the trend.
function mergedWeightSeries(
  samples: HealthSample[] | null,
  log: WeightEntry[],
): Array<{ date: string; kg: number }> {
  const byDate = new Map<string, number>()
  for (const s of samples ?? []) {
    if (typeof s.weight === "number" && s.date) byDate.set(s.date, s.weight)
  }
  for (const e of log) {
    if (e.date && e.kg > 0) byDate.set(e.date, e.kg)
  }
  return [...byDate.entries()]
    .map(([date, kg]) => ({ date, kg }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

// Weight card — the merged trend plus a manual "today" entry. Imported and
// hand-entered readings share one chart.
function WeightCard(props: {
  series: Array<{ date: string; kg: number }>
  todayKg: number | null
  canWrite: boolean
  onSetToday: (kg: number) => void
}) {
  const t = useStrings()
  const { series, todayKg, canWrite } = props
  const latest = series.length ? series[series.length - 1].kg : null
  const prev = series.length > 1 ? series[series.length - 2].kg : null
  const delta = latest != null && prev != null ? latest - prev : null

  return (
    <div className="dash-health__hero">
      <div className="dash-health__hero-head">
        <span className="dash-health__label">{t.weight}</span>
        {latest != null ? (
          <>
            <span className="dash-health__value">
              {latest.toFixed(1)}
              <span className="dash-health__unit">kg</span>
            </span>
            {delta != null && Math.abs(delta) >= 0.05 && (
              <span className="dash-health__delta">
                {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} kg
              </span>
            )}
          </>
        ) : (
          <span className="dash-health__value dash-health__value--muted">—</span>
        )}
      </div>
      {canWrite && (
        <div className="dash-hentry">
          <span className="dash-hentry__label">{t.weightToday}</span>
          <EditableField
            className="dash-hentry__input"
            value={todayKg != null ? String(todayKg) : ""}
            placeholder="—"
            ariaLabel={t.weightInputAria}
            onCommit={(v) => props.onSetToday(parseFloat(v) || 0)}
          />
          <span className="dash-hentry__unit">kg</span>
        </div>
      )}
      <div className="dash-health__chart">
        <TrendChart values={series.slice(-30).map((p) => p.kg)} height={76} fill />
      </div>
    </div>
  )
}

// One meal row. Editable: slot / food / kcal, plus an optional AI
// "estimate" button (✨) that fills kcal from the food description — so a
// meal can be logged without looking the number up. The user can still
// hand-type kcal, or correct an estimate.
function MealRow(props: {
  entry: MealEntry
  canWrite: boolean
  focus: boolean
  estimate: EstimateKcalFn | null
  onPatch: (partial: Partial<MealEntry>) => void
  onRemove: () => void
}) {
  const t = useStrings()
  const { entry: e, canWrite, focus } = props
  const [estimating, setEstimating] = useState(false)

  if (!canWrite) {
    return (
      <div className="dash-cal__row">
        <span className="dash-cal__meal-ro">{t.mealType[e.meal]}</span>
        <span className="dash-cal__food-ro">{e.food}</span>
        <span className="dash-cal__kcal-ro">{(e.kcal || 0).toLocaleString("en-US")} kcal</span>
      </div>
    )
  }

  const runEstimate = async () => {
    const food = e.food.trim()
    if (estimating || !props.estimate || !food) return
    setEstimating(true)
    try {
      const kcal = await props.estimate(food, "food", e.meal)
      if (kcal != null && kcal > 0) props.onPatch({ kcal })
    } finally {
      setEstimating(false)
    }
  }

  return (
    <div className="dash-cal__row">
      <select
        className="dash-cal__meal"
        value={e.meal}
        aria-label={t.mealTypeAria}
        onChange={(ev) => props.onPatch({ meal: ev.currentTarget.value as MealType })}
      >
        {MEAL_TYPES.map((m) => (
          <option key={m} value={m}>
            {t.mealType[m]}
          </option>
        ))}
      </select>
      <EditableField
        className="dash-cal__food"
        value={e.food}
        placeholder={t.foodPlaceholder}
        ariaLabel={t.foodAria}
        focusOnMount={focus}
        onCommit={(food) => props.onPatch({ food })}
      />
      {props.estimate && (
        <button
          type="button"
          className="dash-cal__est"
          title={t.estimateHint}
          aria-label={t.estimateHint}
          disabled={estimating || e.food.trim() === ""}
          onClick={runEstimate}
        >
          {estimating ? "⋯" : "✨"}
        </button>
      )}
      <EditableField
        className="dash-cal__kcal"
        value={e.kcal ? String(e.kcal) : ""}
        placeholder="0"
        ariaLabel={t.kcalAria}
        onCommit={(v) => props.onPatch({ kcal: Math.max(0, Math.round(parseFloat(v) || 0)) })}
      />
      <span className="dash-cal__unit">kcal</span>
      <button
        type="button"
        className="dash-cal__x"
        title={t.removeMeal}
        aria-label={t.removeMeal}
        onClick={props.onRemove}
      >
        ✕
      </button>
    </div>
  )
}

// Calorie card — today's meals grouped by slot, with the day's total.
function CalorieCard(props: {
  entries: MealEntry[]
  canWrite: boolean
  focusMealId: string | null
  estimate: EstimateKcalFn | null
  onPatch: (id: string, partial: Partial<MealEntry>) => void
  onRemove: (id: string) => void
  onAdd: () => void
}) {
  const t = useStrings()
  const { entries, canWrite, focusMealId } = props
  // Rows stay in the order meals were added — a new row appends at the
  // bottom, by the "+ add meal" button. (No re-sort by slot: that made a
  // fresh row jump above the existing ones.)
  const rows = entries
  const total = rows.reduce((s, e) => s + (Number.isFinite(e.kcal) ? e.kcal : 0), 0)

  return (
    <div className="dash-cal">
      <div className="dash-cal__head">
        <span className="dash-health__label">
          {t.calorieTitle} · {t.calorieToday}
        </span>
        <span className="dash-cal__total">
          {total.toLocaleString("en-US")} <span className="dash-health__unit">kcal</span>
        </span>
      </div>
      {rows.length === 0 && <p className="dash-empty">{t.calorieEmpty}</p>}
      {rows.length > 0 && (
        <div className="dash-cal__rows">
          {rows.map((e) => (
            <MealRow
              key={e.id}
              entry={e}
              canWrite={canWrite}
              focus={e.id === focusMealId}
              estimate={props.estimate}
              onPatch={(partial) => props.onPatch(e.id, partial)}
              onRemove={() => props.onRemove(e.id)}
            />
          ))}
        </div>
      )}
      {canWrite && (
        <button type="button" className="dash-cal__add" onClick={props.onAdd}>
          {t.addMeal}
        </button>
      )}
    </div>
  )
}

// One editable exercise row — mirrors MealRow but without a slot select.
// AI ✨ estimate uses the same bridge endpoint with intent: "exercise".
function ExerciseRow(props: {
  entry: ExerciseEntry
  canWrite: boolean
  focus: boolean
  estimate: EstimateKcalFn | null
  onPatch: (partial: Partial<ExerciseEntry>) => void
  onRemove: () => void
}) {
  const t = useStrings()
  const { entry: e, canWrite, focus } = props
  const [estimating, setEstimating] = useState(false)

  if (!canWrite) {
    return (
      <div className="dash-cal__row">
        <span className="dash-cal__food-ro">{e.name}</span>
        <span className="dash-cal__kcal-ro">{(e.kcal || 0).toLocaleString("en-US")} kcal</span>
      </div>
    )
  }

  const runEstimate = async () => {
    const name = e.name.trim()
    if (estimating || !props.estimate || !name) return
    setEstimating(true)
    try {
      const kcal = await props.estimate(name, "exercise")
      if (kcal != null && kcal > 0) props.onPatch({ kcal })
    } finally {
      setEstimating(false)
    }
  }

  return (
    <div className="dash-cal__row">
      <EditableField
        className="dash-cal__food"
        value={e.name}
        placeholder={t.exercisePlaceholder}
        ariaLabel={t.exerciseNameAria}
        focusOnMount={focus}
        onCommit={(name) => props.onPatch({ name })}
      />
      {props.estimate && (
        <button
          type="button"
          className="dash-cal__est"
          title={t.estimateHint}
          aria-label={t.estimateHint}
          disabled={estimating || e.name.trim() === ""}
          onClick={runEstimate}
        >
          {estimating ? "⋯" : "✨"}
        </button>
      )}
      <EditableField
        className="dash-cal__kcal"
        value={e.kcal ? String(e.kcal) : ""}
        placeholder="0"
        ariaLabel={t.kcalAria}
        onCommit={(v) => props.onPatch({ kcal: Math.max(0, Math.round(parseFloat(v) || 0)) })}
      />
      <span className="dash-cal__unit">kcal</span>
      <button
        type="button"
        className="dash-cal__x"
        title={t.removeExercise}
        aria-label={t.removeExercise}
        onClick={props.onRemove}
      >
        ✕
      </button>
    </div>
  )
}

// Exercise card — today's workouts plus an Apple-Health "Active Energy"
// total row when imported. Same in-place editing pattern as the meal log.
function ExerciseCard(props: {
  entries: ExerciseEntry[]
  importedKcal: number
  canWrite: boolean
  focusExerciseId: string | null
  estimate: EstimateKcalFn | null
  onPatch: (id: string, partial: Partial<ExerciseEntry>) => void
  onRemove: (id: string) => void
  onAdd: () => void
}) {
  const t = useStrings()
  const { entries, importedKcal, canWrite, focusExerciseId } = props
  const manualTotal = entries.reduce((s, e) => s + (Number.isFinite(e.kcal) ? e.kcal : 0), 0)
  const total = manualTotal + importedKcal

  return (
    <div className="dash-cal">
      <div className="dash-cal__head">
        <span className="dash-health__label">
          {t.exerciseTitle} · {t.calorieToday}
        </span>
        <span className="dash-cal__total">
          {total.toLocaleString("en-US")} <span className="dash-health__unit">kcal</span>
        </span>
      </div>
      {entries.length === 0 && importedKcal === 0 && (
        <p className="dash-empty">{t.exerciseEmpty}</p>
      )}
      {entries.length > 0 && (
        <div className="dash-cal__rows">
          {entries.map((e) => (
            <ExerciseRow
              key={e.id}
              entry={e}
              canWrite={canWrite}
              focus={e.id === focusExerciseId}
              estimate={props.estimate}
              onPatch={(partial) => props.onPatch(e.id, partial)}
              onRemove={() => props.onRemove(e.id)}
            />
          ))}
        </div>
      )}
      {importedKcal > 0 && (
        <div className="dash-cal__row dash-cal__row--imported">
          <span className="dash-cal__food-ro">{t.energyExerciseImported}</span>
          <span className="dash-cal__kcal-ro">
            {Math.round(importedKcal).toLocaleString("en-US")} kcal
          </span>
        </div>
      )}
      {canWrite && (
        <button type="button" className="dash-cal__add" onClick={props.onAdd}>
          {t.addExercise}
        </button>
      )}
    </div>
  )
}

// Body profile — 3 inline fields that feed Mifflin-St Jeor.
function ProfileEditor(props: {
  profile: DashboardProfile
  setProfile: (partial: Partial<DashboardProfile>) => void
}) {
  const t = useStrings()
  const { profile } = props
  return (
    <div className="dash-profile">
      <label className="dash-profile__field">
        <span className="dash-profile__label">{t.profileHeight}</span>
        <input
          type="number"
          className="dash-profile__input"
          value={profile.heightCm || ""}
          aria-label={t.profileHeight}
          placeholder="—"
          min={80}
          max={250}
          onChange={(e) => props.setProfile({ heightCm: parseFloat(e.currentTarget.value) || 0 })}
        />
      </label>
      <label className="dash-profile__field">
        <span className="dash-profile__label">{t.profileBirthDate}</span>
        <input
          type="date"
          className="dash-profile__input"
          value={profile.birthDate || ""}
          aria-label={t.profileBirthDate}
          onChange={(e) => props.setProfile({ birthDate: e.currentTarget.value })}
        />
      </label>
      <label className="dash-profile__field">
        <span className="dash-profile__label">{t.profileSex}</span>
        <select
          className="dash-profile__input"
          value={profile.sex || ""}
          aria-label={t.profileSex}
          onChange={(e) =>
            props.setProfile({ sex: e.currentTarget.value as DashboardProfile["sex"] })
          }
        >
          <option value="">—</option>
          <option value="male">{t.profileSexValues.male}</option>
          <option value="female">{t.profileSexValues.female}</option>
        </select>
      </label>
    </div>
  )
}

// Energy balance summary — today's intake / expenditure / net, plus an
// EOD projection (linear extrapolation by clock time) and a 7-day average
// translated to a weekly weight delta (7700 kcal ≈ 1 kg fat).
function EnergyBalanceCard(props: {
  weightKg: number | null
  profile: DashboardProfile
  mealLog: MealEntry[]
  exerciseLog: ExerciseEntry[]
  samples: HealthSample[] | null
  canWrite: boolean
  setProfile: (partial: Partial<DashboardProfile>) => void
}) {
  const t = useStrings()
  const today = todayISO()
  const bmr = computeBMR(props.profile, props.weightKg) ?? 0

  const intakeToday = sumKcalOnDate(props.mealLog, today)
  const exerciseManualToday = sumKcalOnDate(props.exerciseLog, today)
  const exerciseImportedToday = activeEnergyOnDate(props.samples, today)
  const exerciseTotalToday = exerciseManualToday + exerciseImportedToday
  const expenditureToday = bmr + exerciseTotalToday
  const net = intakeToday - expenditureToday

  // EOD projection: scale today's running totals by 24/elapsed-hours. BMR
  // is 24h-constant; intake + exercise scale.
  const h = hourOfDay()
  const factor = h > 0.5 ? 24 / h : 1
  const intakeEOD = Math.round(intakeToday * factor)
  const exerciseEOD = Math.round(exerciseTotalToday * factor)
  const expEOD = bmr + exerciseEOD
  const netEOD = intakeEOD - expEOD

  // 7-day net: average over days with any data (skip past empty days, keep
  // today even if partial). Translate to a weekly weight delta.
  let sumNet = 0
  let countDays = 0
  for (let i = 0; i < 7; i++) {
    const d = daysAgoISO(i)
    const intake = sumKcalOnDate(props.mealLog, d)
    const exMan = sumKcalOnDate(props.exerciseLog, d)
    const exImp = activeEnergyOnDate(props.samples, d)
    const hasAny = intake > 0 || exMan > 0 || exImp > 0 || i === 0
    if (!hasAny) continue
    sumNet += intake - (bmr + exMan + exImp)
    countDays++
  }
  const avg7Net = countDays > 0 ? sumNet / countDays : 0
  const weeklyDeltaKg = ((avg7Net * 7) / 7700).toFixed(2)

  const [profileOpen, setProfileOpen] = useState(false)
  const profileIncomplete = bmr === 0

  const netLabel =
    net === 0
      ? t.energyBalanced
      : net < 0
        ? t.energyDeficit(Math.abs(net).toLocaleString("en-US"))
        : t.energySurplus(net.toLocaleString("en-US"))
  const netClass =
    net < 0 ? "dash-energy__net--deficit" : net > 0 ? "dash-energy__net--surplus" : "dash-energy__net--balanced"

  const fmtSigned = (n: number) =>
    n === 0 ? "0" : (n < 0 ? "−" : "+") + Math.abs(n).toLocaleString("en-US")

  return (
    <div className="dash-energy">
      <div className="dash-energy__head">
        <span className="dash-health__label">
          {t.energyTitle} · {t.calorieToday}
        </span>
        <span className={`dash-energy__net ${netClass}`}>{netLabel}</span>
      </div>

      <div className="dash-energy__rows">
        <div className="dash-energy__row">
          <span className="dash-energy__label">{t.energyIntake}</span>
          <span className="dash-energy__value">{intakeToday.toLocaleString("en-US")} kcal</span>
        </div>
        <div className="dash-energy__row">
          <span className="dash-energy__label">{t.energyExpenditure}</span>
          <span className="dash-energy__value">
            {expenditureToday.toLocaleString("en-US")} kcal
          </span>
        </div>
        <div className="dash-energy__sub">
          <span>{t.energyBMR}</span>
          <span>{bmr > 0 ? `${bmr.toLocaleString("en-US")} kcal` : "—"}</span>
        </div>
        <div className="dash-energy__sub">
          <span>{t.energyExercise}</span>
          <span>{exerciseTotalToday.toLocaleString("en-US")} kcal</span>
        </div>
      </div>

      {profileIncomplete && <p className="dash-empty">{t.energyBMRMissing}</p>}

      <div className="dash-energy__proj">
        <span className="dash-health__label">{t.energyProjection}</span>
        <div className="dash-energy__projrow">
          <span>{t.energyEodPredict(formatNowHHMM())}</span>
          <span className="dash-energy__projval">{fmtSigned(netEOD)} kcal</span>
        </div>
        <div className="dash-energy__projrow">
          <span>{t.energy7dayAvg}</span>
          <span className="dash-energy__projval">{t.energyWeeklyDelta(weeklyDeltaKg)}</span>
        </div>
      </div>

      {props.canWrite && (
        <div className="dash-energy__profile">
          <button
            type="button"
            className={`dash-log-toggle${profileOpen ? " is-open" : ""}`}
            onClick={() => setProfileOpen((o) => !o)}
          >
            <span className="dash-log-toggle__caret" aria-hidden="true" />
            {t.profileToggle}
          </button>
          {profileOpen && <ProfileEditor profile={props.profile} setProfile={props.setProfile} />}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Health — the manual log (weight + calories + exercise + body profile,
// entered right here) sits next to the Apple Health metrics pushed from an
// iOS Shortcut (steps / sleep / HR / active energy / resting energy).
// ---------------------------------------------------------------------------
function HealthSection(props: {
  samples: HealthSample[] | null
  error: string | null
  weightLog: WeightEntry[]
  mealLog: MealEntry[]
  exerciseLog: ExerciseEntry[]
  profile: DashboardProfile
  canWrite: boolean
  focusMealId: string | null
  focusExerciseId: string | null
  estimateKcal: EstimateKcalFn | null
  setWeightLog: (mutate: (log: WeightEntry[]) => WeightEntry[]) => void
  setMealLog: (mutate: (log: MealEntry[]) => MealEntry[]) => void
  setExerciseLog: (mutate: (log: ExerciseEntry[]) => ExerciseEntry[]) => void
  setProfile: (partial: Partial<DashboardProfile>) => void
  onAddMeal: () => void
  onAddExercise: () => void
}) {
  const t = useStrings()
  const { samples, error, weightLog, mealLog, exerciseLog, profile, canWrite, focusMealId, focusExerciseId } = props
  const today = todayISO()

  const series = mergedWeightSeries(samples, weightLog)
  const todayWeight = weightLog.find((e) => e.date === today) ?? null
  const latestWeight = series.length ? series[series.length - 1].kg : (todayWeight?.kg ?? null)
  const setTodayWeight = (kg: number) => {
    props.setWeightLog((log) => {
      const rest = log.filter((e) => e.date !== today)
      // Clearing the field (kg ≤ 0) removes today's manual entry.
      if (kg <= 0) return rest
      return [...rest, { id: todayWeight?.id ?? `w-${Date.now()}`, date: today, kg }]
    })
  }

  const todayMeals = mealLog.filter((e) => e.date === today)
  const patchMeal = (id: string, partial: Partial<MealEntry>) =>
    props.setMealLog((log) => log.map((e) => (e.id === id ? { ...e, ...partial } : e)))
  const removeMeal = (id: string) =>
    props.setMealLog((log) => log.filter((e) => e.id !== id))

  const todayExercises = exerciseLog.filter((e) => e.date === today)
  const patchExercise = (id: string, partial: Partial<ExerciseEntry>) =>
    props.setExerciseLog((log) => log.map((e) => (e.id === id ? { ...e, ...partial } : e)))
  const removeExercise = (id: string) =>
    props.setExerciseLog((log) => log.filter((e) => e.id !== id))

  // Apple Health mini metrics — shown only once the phone has pushed samples.
  const importMetrics = HEALTH_MINI_METRICS.map((m) => ({
    ...m,
    vals: (samples ?? [])
      .map((s) => s[m.key])
      .filter((v): v is number => typeof v === "number"),
  }))
  const hasImport = importMetrics.some((m) => m.vals.length > 0)

  // Summary pills — glance numbers for the section header.
  const wPrev = series.length > 1 ? series[series.length - 2].kg : null
  const wDelta = latestWeight != null && wPrev != null ? latestWeight - wPrev : null
  const intakeT = sumKcalOnDate(mealLog, today)
  const exManT = sumKcalOnDate(exerciseLog, today)
  const exImpT = activeEnergyOnDate(samples, today)
  const bmrT = computeBMR(profile, latestWeight) ?? 0
  const hasNetData = intakeT > 0 || exManT > 0 || exImpT > 0 || bmrT > 0
  const netToday = intakeT - (bmrT + exManT + exImpT)
  const todaySample = (samples ?? []).find((s) => s.date === today)
  const stepsToday = typeof todaySample?.steps === "number" ? todaySample.steps : null
  const sleepToday = typeof todaySample?.sleepHours === "number" ? todaySample.sleepHours : null

  return (
    <section className="dash-section">
      <h2>{t.healthTitle}</h2>

      <div className="dash-summary">
        <SummaryPill
          label={t.weight}
          value={
            latestWeight != null ? (
              <>
                {latestWeight.toFixed(1)} kg
                {wDelta != null && Math.abs(wDelta) >= 0.05 && (
                  <span className="dash-summary__delta">
                    {" "}
                    {wDelta > 0 ? "↗" : "↘"} {Math.abs(wDelta).toFixed(1)}
                  </span>
                )}
              </>
            ) : (
              "—"
            )
          }
        />
        <SummaryPill
          label={t.energyNet}
          value={
            hasNetData
              ? `${netToday < 0 ? "−" : netToday > 0 ? "+" : ""}${Math.abs(netToday).toLocaleString("en-US")} kcal`
              : "—"
          }
          tone={hasNetData && netToday !== 0 ? (netToday < 0 ? "good" : "warn") : undefined}
        />
        {stepsToday != null && (
          <SummaryPill
            label={t.healthMetrics.steps}
            value={stepsToday.toLocaleString("en-US")}
          />
        )}
        {sleepToday != null && (
          <SummaryPill
            label={t.healthMetrics.sleepHours}
            value={`${sleepToday.toFixed(1)}h`}
          />
        )}
      </div>

      <div className="dash-health-grid">
        <WeightCard
          series={series}
          todayKg={todayWeight?.kg ?? null}
          canWrite={canWrite}
          onSetToday={setTodayWeight}
        />

        <EnergyBalanceCard
          weightKg={latestWeight}
          profile={profile}
          mealLog={mealLog}
          exerciseLog={exerciseLog}
          samples={samples}
          canWrite={canWrite}
          setProfile={props.setProfile}
        />

        <CalorieCard
          entries={todayMeals}
          canWrite={canWrite}
          focusMealId={focusMealId}
          estimate={props.estimateKcal}
          onPatch={patchMeal}
          onRemove={removeMeal}
          onAdd={props.onAddMeal}
        />

        <ExerciseCard
          entries={todayExercises}
          importedKcal={activeEnergyOnDate(samples, today)}
          canWrite={canWrite}
          focusExerciseId={focusExerciseId}
          estimate={props.estimateKcal}
          onPatch={patchExercise}
          onRemove={removeExercise}
          onAdd={props.onAddExercise}
        />
      </div>

      {hasImport && (
        <div className="dash-health__grid">
          {importMetrics.map((m) => {
            const latest = m.vals[m.vals.length - 1]
            return (
              <div className="dash-health__card" key={m.key}>
                <div className="dash-health__label">{t.healthMetrics[m.key]}</div>
                <div className="dash-health__value dash-health__value--sm">
                  {latest != null ? (
                    <>
                      {latest.toLocaleString("en-US", {
                        minimumFractionDigits: m.digits,
                        maximumFractionDigits: m.digits,
                      })}
                      {m.unit && <span className="dash-health__unit">{m.unit}</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="dash-health__spark">
                  <TrendChart values={m.vals.slice(-20)} height={30} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {error && <p className="dash-empty">{t.healthError(error)}</p>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Finance — read-only view of the latest weekly finance report.
// ---------------------------------------------------------------------------
function FinanceSection(props: { finance: Aggregate["finance"] }) {
  const t = useStrings()
  const fin = props.finance
  const d = fin?.data
  if (fin?.error) {
    return (
      <section className="dash-section">
        <h2>{t.financeTitle}</h2>
        <p className="dash-empty">{t.financeParseError(fin.error)}</p>
      </section>
    )
  }
  if (!d) {
    return (
      <section className="dash-section">
        <h2>{t.financeTitle}</h2>
        <p className="dash-empty">{t.financeNoData}</p>
      </section>
    )
  }

  const acct = d.accounts_snapshot ?? {}
  const sum = d.weekly_summary ?? {}
  const period = d.period ?? {}
  const targets = d.target_performance ?? {}
  const charges: any[] = Array.isArray(d.upcoming_recurring_charges)
    ? d.upcoming_recurring_charges
    : []
  const alerts: any[] = Array.isArray(d.alerts) ? d.alerts : []

  const stats: Array<{ label: string; value: string; tone?: string }> = [
    { label: t.financeCash, value: money(acct?.cash_and_deposits?.total) },
    {
      label: t.financeCredit,
      value: money(acct?.credit_cards?.total_current_balance),
      tone: "warn",
    },
    { label: t.financeNet, value: money(acct?.net_cash_after_credit_card_balances), tone: "good" },
    { label: t.financeControllable, value: money(sum?.controllable_spend_estimate) },
  ]

  // Summary pills — net cash + this-week budget execution.
  const netCash = acct?.net_cash_after_credit_card_balances
  const targetEntries = Object.values<any>(targets)
  const totalActual = targetEntries.reduce((s, tp) => s + Number(tp?.actual ?? 0), 0)
  const totalTarget = targetEntries.reduce((s, tp) => s + Number(tp?.target ?? 0), 0)
  const budgetPct = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0

  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>{t.financeTitle}</h2>
        {period?.label && (
          <span className="dash-tag">
            {period.label} · {fin?.file}
          </span>
        )}
      </div>
      <div className="dash-summary">
        <SummaryPill
          label={t.financeNet}
          value={money(netCash)}
          tone={typeof netCash === "number" ? (netCash < 0 ? "warn" : "good") : undefined}
        />
        {totalTarget > 0 && (
          <SummaryPill
            label={t.summaryWeekBudget}
            value={`${budgetPct}%`}
            tone={budgetPct >= 100 ? "warn" : undefined}
          />
        )}
      </div>
      <div className="dash-stats">
        {stats.map((s) => (
          <div className={`dash-stat${s.tone ? ` dash-stat--${s.tone}` : ""}`} key={s.label}>
            <div className="dash-stat__value">{s.value}</div>
            <div className="dash-stat__label">{s.label}</div>
          </div>
        ))}
      </div>

      {(Object.keys(targets).length > 0 || charges.length > 0) && (
        // Budget bars + upcoming subscriptions sit side-by-side in 2 cols;
        // each was a full-width list with a big empty middle before.
        <div className="dash-finance-row">
          {Object.keys(targets).length > 0 && (
            <div className="dash-sub">
              <h3>{t.financeBudget}</h3>
              {Object.entries<any>(targets).map(([key, tp]) => {
                const actual = Number(tp?.actual ?? 0)
                const target = Number(tp?.target ?? 0)
                const pct = target > 0 ? clampPct((actual / target) * 100) : 0
                const over = target > 0 && actual > target
                return (
                  <div className="dash-target" key={key}>
                    <span className="dash-target__label">{t.financeTargetLabel(key)}</span>
                    <div className="dash-bar">
                      <div
                        className={`dash-bar__fill${over ? " is-over" : ""}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="dash-target__num">
                      {money(actual)} / {money(target)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {charges.length > 0 && (
            <div className="dash-sub">
              <h3>{t.financeCharges}</h3>
              <ul className="dash-list">
                {charges.slice(0, 6).map((c, idx) => (
                  <li key={idx}>
                    <span className="dash-list__main">{c?.description || c?.merchant}</span>
                    <span className="dash-list__meta">
                      {money(c?.average_amount)} · {fmtDate(c?.predicted_next_date)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="dash-sub">
          <h3>{t.financeAlerts}</h3>
          <ul className="dash-alerts">
            {alerts.map((a, idx) => (
              <li className={`dash-alert dash-alert--${a?.severity ?? "info"}`} key={idx}>
                {a?.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Custom metrics — in-place editable (label / value / unit / note are editable
// text fields). Adding a card appends an empty editable tile.
// ---------------------------------------------------------------------------
const TREND_GLYPH: Record<string, string> = { up: "▲", down: "▼", flat: "▬", none: "" }

function MetricsSection(props: {
  metrics: DashboardMetric[]
  canWrite: boolean
  focusMetricId: string | null
  setMetrics: (mutate: (metrics: DashboardMetric[]) => DashboardMetric[]) => void
  onAddMetric: () => void
}) {
  const t = useStrings()
  const { metrics, canWrite, focusMetricId } = props

  const patchMetric = (id: string, partial: Partial<DashboardMetric>) =>
    props.setMetrics((ms) => ms.map((m) => (m.id === id ? { ...m, ...partial } : m)))
  const removeMetric = (id: string) => props.setMetrics((ms) => ms.filter((m) => m.id !== id))

  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>{t.metricsTitle}</h2>
        {canWrite && (
          <button className="dash-btn" onClick={props.onAddMetric}>
            {t.addMetric}
          </button>
        )}
      </div>
      {metrics.length === 0 && <p className="dash-empty">{t.metricsEmpty}</p>}
      <div className="dash-stats">
        {metrics.map((m) => (
          <div className="dash-stat dash-stat--metric" key={m.id}>
            {canWrite ? (
              <>
                <button
                  className="dash-goal__remove dash-stat__remove"
                  title={t.removeMetric}
                  onClick={() => removeMetric(m.id)}
                >
                  ✕
                </button>
                <div className="dash-stat__value-row">
                  <EditableField
                    className="dash-stat__value-input"
                    value={m.value}
                    placeholder="—"
                    ariaLabel={t.metricValueAria}
                    onCommit={(value) => patchMetric(m.id, { value })}
                  />
                  <EditableField
                    className="dash-stat__unit-input"
                    value={m.unit}
                    placeholder={t.metricUnitPlaceholder}
                    ariaLabel={t.metricUnitAria}
                    onCommit={(unit) => patchMetric(m.id, { unit })}
                  />
                  {m.trend !== "none" && (
                    <span className={`dash-stat__trend dash-stat__trend--${m.trend}`}>
                      {TREND_GLYPH[m.trend]}
                    </span>
                  )}
                </div>
                <EditableField
                  className="dash-stat__label-input"
                  value={m.label}
                  placeholder={t.metricLabelPlaceholder}
                  ariaLabel={t.metricLabelAria}
                  focusOnMount={m.id === focusMetricId}
                  onCommit={(label) => patchMetric(m.id, { label })}
                />
                <EditableField
                  className="dash-stat__note-input"
                  value={m.note}
                  placeholder={t.notePlaceholder}
                  ariaLabel={t.metricNoteAria}
                  onCommit={(note) => patchMetric(m.id, { note })}
                />
              </>
            ) : (
              <>
                <div className="dash-stat__value">
                  {m.value || "—"}
                  {m.unit && <span className="dash-stat__unit">{m.unit}</span>}
                  {m.trend !== "none" && (
                    <span className={`dash-stat__trend dash-stat__trend--${m.trend}`}>
                      {TREND_GLYPH[m.trend]}
                    </span>
                  )}
                </div>
                <div className="dash-stat__label">{m.label}</div>
                {m.note && <div className="dash-stat__note">{m.note}</div>}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Workflows — run status of the content-tree workflows.
// ---------------------------------------------------------------------------
function WorkflowsSection(props: { workflows: Aggregate["workflows"] }) {
  const t = useStrings()
  const wfs = props.workflows ?? []
  return (
    <section className="dash-section">
      <h2>{t.workflowsTitle}</h2>
      {wfs.length === 0 && <p className="dash-empty">{t.workflowsEmpty}</p>}
      <div className="dash-cards">
        {wfs.map((w) => (
          <a className="dash-card" href={`/${w.slug}`} key={w.slug}>
            <div className="dash-card__title">{w.name}</div>
            <div className="dash-card__meta">
              <span>{t.runCount(w.runCount)}</span>
              {w.latestStatus && (
                <span className={`dash-pill dash-pill--${w.latestStatus}`}>{w.latestStatus}</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Thoughts / Diary activity.
// ---------------------------------------------------------------------------
function ThoughtsSection(props: { thoughts: Aggregate["thoughts"] }) {
  const t = useStrings()
  const th = props.thoughts ?? {}
  const recent = th.recent ?? []
  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>{t.thoughtsTitle}</h2>
        <span className="dash-tag">{t.thoughtsCount(th.total ?? 0)}</span>
      </div>
      {recent.length === 0 && <p className="dash-empty">{t.thoughtsEmpty}</p>}
      <ul className="dash-list">
        {recent.map((r) => (
          <li key={r.slug}>
            <a className="dash-list__main" href={`/${r.slug}`}>
              {r.title}
            </a>
            <span className="dash-list__meta">{fmtDate(r.mtime)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Bridge sessions / tickets.
// ---------------------------------------------------------------------------
function BridgeSection(props: { bridge: Aggregate["bridge"] }) {
  const t = useStrings()
  const b = props.bridge ?? {}
  const sessions = b.sessions ?? []
  const tickets = b.tickets ?? []
  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>{t.bridgeTitle}</h2>
        <span className={`dash-pill dash-pill--${b.ok ? "ok" : "error"}`}>
          {b.ok ? t.bridgeOnline : t.bridgeOffline}
        </span>
      </div>
      {!b.ok && <p className="dash-empty">{t.bridgeConnError(b.origin ?? "", b.error ?? "")}</p>}
      {b.ok && (
        <div className="dash-bridge">
          <div className="dash-sub">
            <h3>{t.bridgeSessions(sessions.length)}</h3>
            <ul className="dash-list">
              {sessions.map((s: any, idx: number) => (
                <li key={s?.sessionId ?? idx}>
                  <span className="dash-list__main">
                    {s?.role?.displayName || s?.kind || s?.sessionId}
                  </span>
                  <span className="dash-list__meta">{s?.state ?? s?.detectorState}</span>
                </li>
              ))}
              {sessions.length === 0 && <li className="dash-empty">{t.bridgeNoSessions}</li>}
            </ul>
          </div>
          <div className="dash-sub">
            <h3>{t.bridgeTickets(tickets.length)}</h3>
            <ul className="dash-list">
              {tickets.slice(0, 8).map((tk: any, idx: number) => (
                <li key={tk?.id ?? idx}>
                  <span className="dash-list__main">{tk?.summary || tk?.title || tk?.id}</span>
                  <span className={`dash-pill dash-pill--${tk?.status ?? "open"}`}>
                    {tk?.status ?? "—"}
                  </span>
                </li>
              ))}
              {tickets.length === 0 && <li className="dash-empty">{t.bridgeNoTickets}</li>}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
function Dashboard(props: {
  initialData: DashboardData
  canWrite: boolean
  bridgeOrigin: string
  write: WidgetMountContext<DashboardData>["write"]
}) {
  const { canWrite, write, bridgeOrigin } = props
  const [data, setData] = useState<DashboardData>(props.initialData)
  const [agg, setAgg] = useState<Aggregate | null>(null)
  const [aggErr, setAggErr] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthSample[] | null>(null)
  const [healthErr, setHealthErr] = useState<string | null>(null)
  // Persistence is silent (no save badge). A failed write is the only thing
  // worth surfacing — shown briefly, then the optimistic change is rolled back.
  const [writeErr, setWriteErr] = useState<string | null>(null)
  // The goal / metric a "+ add" click just created, so its first field can
  // grab focus on mount.
  const [focusGoalId, setFocusGoalId] = useState<string | null>(null)
  const [focusMetricId, setFocusMetricId] = useState<string | null>(null)
  const [focusMealId, setFocusMealId] = useState<string | null>(null)
  const [focusExerciseId, setFocusExerciseId] = useState<string | null>(null)

  // Display locale comes from the global chrome toggle — track it in state so
  // the panel re-renders when the user switches language.
  const [locale, setLocale] = useState<DashLocale>(readGlobalLocale)
  useEffect(() => {
    const onLangChange = (e: Event) => {
      const lang = (e as CustomEvent<{ lang?: string }>).detail?.lang
      if (lang === "en-US" || lang === "zh-CN") setLocale(lang)
    }
    document.addEventListener("langchange", onLangChange)
    return () => document.removeEventListener("langchange", onLangChange)
  }, [])
  const t = useMemo(() => getStrings(locale), [locale])

  // dataRef mirrors `data` synchronously so successive edits in the same tick
  // (e.g. blur-commit of a field immediately followed by another action)
  // always build on the latest state, not a stale render closure.
  const dataRef = useRef<DashboardData>(props.initialData)
  // lastSaved is the most recent server-confirmed state — the rollback target
  // if a write fails.
  const lastSaved = useRef<DashboardData>(props.initialData)
  // Writes coalesce: edits mark top-level keys dirty, a debounced flush sends
  // ONE request, and only one request is ever in flight. Without this, a
  // "+ add" write and the title-edit write that immediately follows it each
  // send a full /goals snapshot — last-write-wins would clobber the title.
  const dirty = useRef<Set<keyof DashboardData>>(new Set())
  const inFlight = useRef(false)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadAggregate = useCallback(async () => {
    try {
      const res = await fetch(`/dashboard-aggregate.json?ts=${Date.now()}`, {
        cache: "no-cache",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setAgg((await res.json()) as Aggregate)
      setAggErr(null)
    } catch (e) {
      setAggErr((e as Error).message)
    }
  }, [])

  // Health metrics come straight from the bridge, not the build-time
  // aggregate — so a refresh shows samples the moment the phone pushes them,
  // without waiting for a site rebuild.
  const loadHealth = useCallback(async () => {
    if (!bridgeOrigin) {
      setHealthErr("bridge unavailable")
      return
    }
    try {
      const res = await fetch(`${bridgeOrigin}/api/metrics/health?ts=${Date.now()}`, {
        cache: "no-cache",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setHealth(Array.isArray(json?.samples) ? (json.samples as HealthSample[]) : [])
      setHealthErr(null)
    } catch (e) {
      setHealthErr((e as Error).message)
    }
  }, [bridgeOrigin])

  useEffect(() => {
    void loadAggregate()
    void loadHealth()
  }, [loadAggregate, loadHealth])

  // Flush the dirty top-level keys in ONE write. Each key is sent as a whole
  // `add /<key>` of its freshest value (dataRef) — an idempotent, index-free
  // patch (`add` sets-or-replaces an object member, so a key absent from an
  // older data.json is created rather than erroring). Serialized: if a write
  // is already in flight, this no-ops and the in-flight write re-flushes on
  // completion. On failure, roll back to the last server-confirmed state.
  const flush = useCallback(() => {
    if (inFlight.current || dirty.current.size === 0) return
    const keys = [...dirty.current]
    dirty.current.clear()
    const snapshot = dataRef.current
    const patch: JsonPatchOp[] = keys.map((k) => ({
      op: "add",
      path: `/${k}`,
      value: snapshot[k],
    }))
    inFlight.current = true
    void write({ patch }).then((r) => {
      inFlight.current = false
      if (r.ok) {
        lastSaved.current = snapshot
        setWriteErr(null)
      } else {
        dirty.current.clear()
        dataRef.current = lastSaved.current
        setData(lastSaved.current)
        setWriteErr(r.error?.message ?? "save failed")
        clearTimeout(errTimer.current)
        errTimer.current = setTimeout(() => setWriteErr(null), 4000)
      }
      // Edits that landed while this write was in flight — send them now.
      if (dirty.current.size > 0) flush()
    })
  }, [write])

  // Optimistic edit: `mutate` runs against the freshest state (dataRef), the
  // result is shown immediately, and the touched keys are marked dirty for a
  // debounced flush that coalesces a burst of edits into one write.
  const commit = useCallback(
    (mutate: (cur: DashboardData) => DashboardData, keys: Array<keyof DashboardData>) => {
      if (!canWrite) return
      const next = mutate(dataRef.current)
      dataRef.current = next
      setData(next)
      for (const k of keys) dirty.current.add(k)
      clearTimeout(flushTimer.current)
      flushTimer.current = setTimeout(flush, 60)
    },
    [canWrite, flush],
  )

  const setGoals = useCallback(
    (mutate: (goals: DashboardGoal[]) => DashboardGoal[]) =>
      commit((cur) => ({ ...cur, goals: mutate(cur.goals) }), ["goals"]),
    [commit],
  )
  const setMetrics = useCallback(
    (mutate: (metrics: DashboardMetric[]) => DashboardMetric[]) =>
      commit((cur) => ({ ...cur, metrics: mutate(cur.metrics) }), ["metrics"]),
    [commit],
  )
  const setView = useCallback(
    (partial: Partial<DashboardView>) =>
      commit((cur) => ({ ...cur, view: { ...cur.view, ...partial } }), ["view"]),
    [commit],
  )
  const addGoal = useCallback(
    (cadence: GoalCadence) => {
      const goal: DashboardGoal = {
        id: `g-${Date.now()}`,
        title: "",
        note: "",
        status: "todo",
        priority: "none",
        tags: [],
        dueDate: "",
        log: [],
        cadence,
        estimatedMinutes: 0,
      }
      setGoals((gs) => [...gs, goal])
      setFocusGoalId(goal.id)
    },
    [setGoals],
  )
  const addMetric = useCallback(() => {
    const metric: DashboardMetric = {
      id: `m-${Date.now()}`,
      label: "",
      value: "",
      unit: "",
      note: "",
      trend: "none",
    }
    setMetrics((ms) => [...ms, metric])
    setFocusMetricId(metric.id)
  }, [setMetrics])
  const setWeightLog = useCallback(
    (mutate: (log: WeightEntry[]) => WeightEntry[]) =>
      commit((cur) => ({ ...cur, weightLog: mutate(cur.weightLog) }), ["weightLog"]),
    [commit],
  )
  const setMealLog = useCallback(
    (mutate: (log: MealEntry[]) => MealEntry[]) =>
      commit((cur) => ({ ...cur, mealLog: mutate(cur.mealLog) }), ["mealLog"]),
    [commit],
  )
  const addMeal = useCallback(() => {
    const today = todayISO()
    const id = `meal-${Date.now()}`
    setMealLog((log) => {
      // Default the slot to the last meal logged today — usually you're
      // adding to the same or a later meal, never re-opening breakfast.
      const todayMeals = log.filter((m) => m.date === today)
      const meal: MealType = todayMeals.length
        ? todayMeals[todayMeals.length - 1].meal
        : "breakfast"
      return [...log, { id, date: today, meal, food: "", kcal: 0 }]
    })
    setFocusMealId(id)
  }, [setMealLog])
  const setExerciseLog = useCallback(
    (mutate: (log: ExerciseEntry[]) => ExerciseEntry[]) =>
      commit((cur) => ({ ...cur, exerciseLog: mutate(cur.exerciseLog) }), ["exerciseLog"]),
    [commit],
  )
  const setProfile = useCallback(
    (partial: Partial<DashboardProfile>) =>
      commit((cur) => ({ ...cur, profile: { ...cur.profile, ...partial } }), ["profile"]),
    [commit],
  )
  const addExercise = useCallback(() => {
    const id = `ex-${Date.now()}`
    setExerciseLog((log) => [...log, { id, date: todayISO(), name: "", kcal: 0 }])
    setFocusExerciseId(id)
  }, [setExerciseLog])
  // AI kcal estimate — generic over food/exercise via the `intent` flag.
  // Returns null on any failure so the row leaves kcal for the user to type.
  const estimateKcal = useCallback<EstimateKcalFn>(
    async (description, intent, context) => {
      if (!bridgeOrigin) return null
      try {
        const res = await fetch(`${bridgeOrigin}/api/metrics/estimate-calories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description, intent, context }),
        })
        if (!res.ok) return null
        const json = await res.json()
        return typeof json?.kcal === "number" ? json.kcal : null
      } catch {
        return null
      }
    },
    [bridgeOrigin],
  )
  // AI task-time estimate — feeds the goal card's ✨ button.
  const estimateTaskTime = useCallback(
    async (title: string, note: string): Promise<number | null> => {
      if (!bridgeOrigin) return null
      try {
        const res = await fetch(`${bridgeOrigin}/api/tasks/estimate-time`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, note }),
        })
        if (!res.ok) return null
        const json = await res.json()
        return typeof json?.minutes === "number" ? json.minutes : null
      } catch {
        return null
      }
    },
    [bridgeOrigin],
  )

  return (
    <StringsContext.Provider value={t}>
      <div className="dashboard">
        {/* A plain div, not <header> — Quartz's content CSS gives the <header>
            element a 2rem block margin, which bloated this row. */}
        <div className="dash-header">
          <p className="dash-subtitle">
            {agg?.generatedAt
              ? t.updatedAt(new Date(agg.generatedAt).toLocaleString())
              : t.loadingAggregate}
          </p>
          <div className="dash-header__actions">
            {writeErr && (
              <span className="dash-save dash-save--error">{t.saveFailed(writeErr)}</span>
            )}
            <button
              className="dash-btn"
              onClick={() => {
                void loadAggregate()
                void loadHealth()
              }}
            >
              ↻ {t.refresh}
            </button>
          </div>
        </div>

        {aggErr && <p className="dash-empty">{t.aggError(aggErr)}</p>}

        <GoalsSection
          goals={data.goals}
          view={data.view}
          canWrite={canWrite}
          focusGoalId={focusGoalId}
          estimateTaskTime={bridgeOrigin ? estimateTaskTime : null}
          setGoals={setGoals}
          setView={setView}
          onAddGoal={addGoal}
        />
        <HealthSection
          samples={health}
          error={healthErr}
          weightLog={data.weightLog}
          mealLog={data.mealLog}
          exerciseLog={data.exerciseLog}
          profile={data.profile}
          canWrite={canWrite}
          focusMealId={focusMealId}
          focusExerciseId={focusExerciseId}
          estimateKcal={bridgeOrigin ? estimateKcal : null}
          setWeightLog={setWeightLog}
          setMealLog={setMealLog}
          setExerciseLog={setExerciseLog}
          setProfile={setProfile}
          onAddMeal={addMeal}
          onAddExercise={addExercise}
        />
        <FinanceSection finance={agg?.finance} />
        <MetricsSection
          metrics={data.metrics}
          canWrite={canWrite}
          focusMetricId={focusMetricId}
          setMetrics={setMetrics}
          onAddMetric={addMetric}
        />
        <WorkflowsSection workflows={agg?.workflows} />
        <ThoughtsSection thoughts={agg?.thoughts} />
        <BridgeSection bridge={agg?.bridge} />
      </div>
    </StringsContext.Provider>
  )
}

export function mountDashboard(ctx: WidgetMountContext<DashboardData>): () => void {
  if (!ctx.data) {
    ctx.el.innerHTML = '<div class="quartz-widget__error">Dashboard data not loaded.</div>'
    return () => {
      ctx.el.innerHTML = ""
    }
  }

  const host = document.createElement("div")
  host.className = "dashboard-host"
  ctx.el.innerHTML = ""
  ctx.el.appendChild(host)

  const root: Root = createRoot(host)
  root.render(
    React.createElement(Dashboard, {
      initialData: ctx.data,
      canWrite: ctx.capabilities.canWrite,
      bridgeOrigin: ctx.capabilities.bridgeOrigin,
      write: ctx.write,
    }),
  )

  return () => {
    root.unmount()
    ctx.el.innerHTML = ""
  }
}
