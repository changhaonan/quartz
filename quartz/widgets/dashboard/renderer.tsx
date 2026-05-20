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
import { writeWidget } from "../client"
import type {
  DashboardData,
  DashboardGoal,
  DashboardMetric,
  DashboardProfile,
  DashboardView,
  ExerciseEntry,
  GoalKind,
  GoalLogEntry,
  GoalPriority,
  GoalSize,
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
interface AggLearningArticle {
  slug: string
  title: string
  status: "unread" | "reading" | "read"
  understood: number
  source: string
}
interface AggLearningStats {
  articles: number
  read: number
  reading: number
  understood: number
}
interface AggLearningSubdomain {
  id: string
  label: string
  slug: string
  articles: AggLearningArticle[]
  stats: AggLearningStats
}
interface AggLearningDomain {
  id: string
  label: string
  slug: string
  target: number
  subdomains: AggLearningSubdomain[]
  stats: AggLearningStats
}
interface AggLearningTree {
  domains: AggLearningDomain[]
  stats: AggLearningStats
}

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
  learning?: AggLearningTree
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
  tone?: "good" | "watch" | "warn" | "muted"
}) {
  const tone = props.tone ? ` dash-summary__pill--${props.tone}` : ""
  return (
    <div className={`dash-summary__pill${tone}`}>
      <span className="dash-summary__label">{props.label}</span>
      <span className="dash-summary__value">{props.value}</span>
    </div>
  )
}

// "Work" comes from the explicit `kind` field; legacy goals with the
// "work" / "工作" tag still count, so old data tagged that way is not
// lost when the summary tallies.
const WORK_TAGS = new Set(["work", "工作", "office", "job"])
function isWorkGoal(g: DashboardGoal): boolean {
  if (g.kind === "work") return true
  return g.tags.some((t) => WORK_TAGS.has(t.toLowerCase()))
}

const GOAL_SIZES: Array<Exclude<GoalSize, "">> = ["S", "M", "L"]

// Treat unset size as M so a sized-soon goal isn't undercounted.
type SizedTier = "S" | "M" | "L"
function tierOf(g: DashboardGoal): SizedTier {
  return (g.size || "M") as SizedTier
}

// Tone for a 0..∞ load percent. <70 green, 70-100 amber, >100 red.
function loadTone(pct: number): "good" | "watch" | "warn" {
  if (pct > 100) return "warn"
  if (pct >= 70) return "watch"
  return "good"
}

// Section load% per kind: count "doing" goals into L/M/S buckets and
// take the max bucket-ratio (doing / cap). The most-stretched tier
// drives the colour and the headline %. Tiers with cap 0 are skipped.
function tierLoad(
  doing: DashboardGoal[],
  match: (g: DashboardGoal) => boolean,
  cap: { L: number; M: number; S: number },
): { c: { L: number; M: number; S: number }; pct: number } {
  const c = { L: 0, M: 0, S: 0 }
  for (const g of doing) if (match(g)) c[tierOf(g)]++
  const ratios: number[] = []
  for (const t of ["L", "M", "S"] as const) {
    if (cap[t] > 0) ratios.push(c[t] / cap[t])
  }
  const pct = ratios.length ? Math.round(Math.max(...ratios) * 100) : 0
  return { c, pct }
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
  // Multi-line mode: renders a <textarea> that auto-grows with content
  // (CSS `field-sizing: content`). Enter inserts a newline; the field
  // commits on blur. Cmd/Ctrl+Enter forces a blur (commit-and-leave).
  multiline?: boolean
  onCommit: (value: string) => void
}) {
  const { value, placeholder, className, ariaLabel, focusOnMount, multiline } = props
  const [buf, setBuf] = useState(value)
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

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

  const cls = `dash-edit${multiline ? " dash-edit--multiline" : ""}${className ? ` ${className}` : ""}`
  const onBlur = () => {
    if (buf !== value) props.onCommit(buf)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setBuf(value)
      window.setTimeout(() => ref.current?.blur(), 0)
      return
    }
    if (e.key === "Enter") {
      if (multiline) {
        // Cmd/Ctrl+Enter commits-and-leaves; bare Enter inserts a newline.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      } else {
        e.preventDefault()
        e.currentTarget.blur()
      }
    }
  }

  if (multiline) {
    return (
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        className={cls}
        rows={1}
        value={buf}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => setBuf(e.currentTarget.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    )
  }
  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className={cls}
      type="text"
      value={buf}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setBuf(e.currentTarget.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  )
}

// ---------------------------------------------------------------------------
// Goals — a Notion-style board grouped by STATUS (未开始 / 进行中 / 暂停 /
// 已完成). Drag a card between columns to change its status. Editing is
// in-place.
// ---------------------------------------------------------------------------
const BOARD_STATUSES: GoalStatus[] = ["todo", "doing", "paused", "done"]

// Where a drag is currently pointing: a column, and the card it would land
// before (null = end of the column).
interface DropTarget {
  status: GoalStatus
  beforeId: string | null
}

// Move `id` to `status`, inserting before `beforeId` (or at the column's
// end when null). Goals of different statuses interleave freely in the
// array — the per-column filter preserves relative order, so splicing
// before `beforeId` lands the card exactly where the drop indicator showed.
function moveGoal(
  goals: DashboardGoal[],
  id: string,
  status: GoalStatus,
  beforeId: string | null,
): DashboardGoal[] {
  const dragged = goals.find((g) => g.id === id)
  if (!dragged) return goals
  const rest = goals.filter((g) => g.id !== id)
  // Stamp / clear completedAt as the card crosses into / out of "已完成".
  // Identical bookkeeping to the inline status pill (see StatusControl
  // call site below).
  let completedAt = dragged.completedAt
  if (status === "done" && !completedAt) completedAt = todayISO()
  else if (status !== "done" && completedAt) completedAt = ""
  const moved: DashboardGoal = { ...dragged, status, completedAt }
  const idx = beforeId ? rest.findIndex((g) => g.id === beforeId) : -1
  if (idx < 0) rest.push(moved)
  else rest.splice(idx, 0, moved)
  return rest
}

// --- Card property controls (Notion-database style) ------------------------
const STATUS_VALUES: GoalStatus[] = ["todo", "doing", "paused", "done"]
// Priority select order: "none" first (acts as the placeholder), then high→low.
const PRIORITY_VALUES: GoalPriority[] = ["none", "high", "mid", "low"]
const SORT_VALUES: DashboardView["sort"][] = ["manual", "priority", "dueDate", "status"]

// --- Board view: filtering + sorting ---------------------------------------
// Sort ranks. Status: active work first, done last. Priority: high first.
const STATUS_RANK: Record<GoalStatus, number> = { doing: 0, todo: 1, paused: 2, done: 3 }
const PRIORITY_RANK: Record<GoalPriority, number> = { high: 0, mid: 1, low: 2, none: 3 }

function matchesView(g: DashboardGoal, v: DashboardView): boolean {
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
  estimateTaskSize: ((title: string, note: string) => Promise<GoalSize | null>) | null
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
  const [estimating, setEstimating] = useState(false)
  const isWork = g.kind === "work"
  const showProps =
    canWrite ||
    g.priority !== "none" ||
    Boolean(g.dueDate) ||
    g.size !== "" ||
    isWork

  const runSizeEstimate = async () => {
    const title = g.title.trim()
    if (estimating || !props.estimateTaskSize || !title) return
    setEstimating(true)
    try {
      const size = await props.estimateTaskSize(title, g.note)
      if (size) props.onPatch({ size })
    } finally {
      setEstimating(false)
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
            multiline
            onCommit={(note) => props.onPatch({ note })}
          />
        ) : (
          g.note && <div className="dash-gcard__note">{g.note}</div>
        )}

        <StatusControl
          status={g.status}
          canWrite={canWrite}
          onChange={(status) => {
            // Stamp/clear completedAt as the goal flips in/out of "done" so
            // the daily archive sweep knows which month bucket to send it to.
            const patch: Partial<DashboardGoal> = { status }
            if (status === "done" && !g.completedAt) {
              patch.completedAt = todayISO()
            } else if (status !== "done" && g.completedAt) {
              patch.completedAt = ""
            }
            props.onPatch(patch)
          }}
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
              <select
                className={`dash-kind dash-kind--${g.kind}`}
                value={g.kind}
                aria-label={t.goalKindAria}
                onChange={(e) => props.onPatch({ kind: e.currentTarget.value as GoalKind })}
              >
                <option value="personal">{t.goalKind.personal}</option>
                <option value="work">{t.goalKind.work}</option>
              </select>
            ) : (
              isWork && (
                <span className="dash-kindpill dash-kindpill--work">{t.goalKind.work}</span>
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
              <span className="dash-size">
                <span className="dash-seg dash-seg--size" role="group" aria-label={t.goalSizeAria}>
                  {GOAL_SIZES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`dash-seg__btn dash-seg__btn--size-${s}${g.size === s ? " is-active" : ""}`}
                      onClick={() => props.onPatch({ size: g.size === s ? "" : s })}
                    >
                      {t.goalSize[s]}
                    </button>
                  ))}
                </span>
                {props.estimateTaskSize && (
                  <button
                    type="button"
                    className="dash-size__ai"
                    title={t.estimateAIHint}
                    aria-label={t.estimateAIHint}
                    disabled={estimating || g.title.trim() === ""}
                    onClick={runSizeEstimate}
                  >
                    {estimating ? "⋯" : "✨"}
                  </button>
                )}
              </span>
            ) : (
              g.size !== "" && (
                <span className={`dash-sizepill dash-sizepill--${g.size}`}>
                  {t.goalSize[g.size as Exclude<GoalSize, "">]}
                </span>
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
  status: GoalStatus
  rows: DashboardGoal[]
  canWrite: boolean
  // When a sort is active, within-column position is sort-determined: a drop
  // means "this column", so we suppress the between-cards drop indicator.
  sorted: boolean
  filterActive: boolean
  draggingId: string | null
  focusGoalId: string | null
  drop: DropTarget | null
  estimateTaskSize: ((title: string, note: string) => Promise<GoalSize | null>) | null
  onCardPatch: (id: string, partial: Partial<DashboardGoal>) => void
  onRemove: (id: string) => void
  onAdd: (status: GoalStatus) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDropHint: (target: DropTarget) => void
  onDrop: () => void
}) {
  const t = useStrings()
  const { status, rows, canWrite, sorted, draggingId, focusGoalId, drop } = props
  const isActive = drop?.status === status
  const dropLine = (beforeId: string | null) =>
    !sorted && isActive && drop?.beforeId === beforeId ? <div className="dash-drop-line" /> : null

  return (
    <div
      className={`dash-col dash-col--${status}${isActive ? " is-droptarget" : ""}`}
      onDragOver={
        canWrite
          ? (e) => {
              e.preventDefault()
              // Bare column area (below the cards) — drop at the end.
              props.onDropHint({ status, beforeId: null })
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
        <span className="dash-col__title">{t.status[status]}</span>
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
              estimateTaskSize={props.estimateTaskSize}
              onPatch={(partial) => props.onCardPatch(g.id, partial)}
              onRemove={() => props.onRemove(g.id)}
              onDragStart={() => props.onDragStart(g.id)}
              onDragEnd={props.onDragEnd}
              onDragOver={(before) =>
                props.onDropHint({
                  status,
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
        <button className="dash-col__add" onClick={() => props.onAdd(status)}>
          {t.addGoal}
        </button>
      )}
    </div>
  )
}

function GoalsSection(props: {
  goals: DashboardGoal[]
  view: DashboardView
  profile: DashboardProfile
  canWrite: boolean
  focusGoalId: string | null
  estimateTaskSize: ((title: string, note: string) => Promise<GoalSize | null>) | null
  // Mutate the goals array and persist.
  setGoals: (mutate: (goals: DashboardGoal[]) => DashboardGoal[]) => void
  // Patch the persisted view (filter / sort) state.
  setView: (partial: Partial<DashboardView>) => void
  onAddGoal: (status: GoalStatus) => void
}) {
  const t = useStrings()
  const { goals, view, profile, canWrite, focusGoalId } = props
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
    if (id && target) props.setGoals((gs) => moveGoal(gs, id, target.status, target.beforeId))
    endDrag()
  }

  // Tags present across all goals — populates the tag-filter dropdown.
  const allTags = [...new Set(goals.flatMap((g) => g.tags))].sort()
  const filterActive = view.filterPriority !== "all" || view.filterTag !== ""
  const visible = goals.filter((g) => matchesView(g, view))
  const doneCount = goals.filter((g) => g.status === "done").length
  // "done" is hidden by default — it's effectively archive. The toolbar
  // toggle (with its count) reveals the column on demand.
  const columns = view.showDone ? BOARD_STATUSES : BOARD_STATUSES.filter((s) => s !== "done")

  // Summary pills: per-kind tier-aware load. Only "doing" counts as
  // load (todo / paused / done don't). Pill % = max stretched tier; the
  // L·M·S breakdown is shown inline.
  const today = todayISO()
  const activeGoals = goals.filter((g) => g.status !== "done")
  const doing = goals.filter((g) => g.status === "doing")
  const work = tierLoad(doing, isWorkGoal, profile.workCapacity)
  const personal = tierLoad(doing, (g) => !isWorkGoal(g), profile.personalCapacity)
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
            <button
              type="button"
              className={`dash-vtoggle${view.showDone ? " is-on" : ""}`}
              aria-label={t.toggleDoneAria}
              aria-pressed={view.showDone}
              onClick={() => props.setView({ showDone: !view.showDone })}
              title={t.toggleDoneAria}
            >
              {t.doneToggle(doneCount)}
            </button>
          </div>
        )}
      </div>
      <div className="dash-summary">
        <SummaryPill
          label={t.summaryWork}
          value={
            <>
              {work.pct}%{" "}
              <span className="dash-summary__detail">
                {work.c.L}L · {work.c.M}M · {work.c.S}S
              </span>
            </>
          }
          tone={loadTone(work.pct)}
        />
        <SummaryPill
          label={t.summaryPersonal}
          value={
            <>
              {personal.pct}%{" "}
              <span className="dash-summary__detail">
                {personal.c.L}L · {personal.c.M}M · {personal.c.S}S
              </span>
            </>
          }
          tone={loadTone(personal.pct)}
        />
        <SummaryPill
          label={t.summaryOverdue}
          value={`${overdueRate}%`}
          tone={overdueCount > 0 ? "warn" : undefined}
        />
      </div>
      <div className={`dash-board dash-board--cols-${columns.length}`}>
        {columns.map((status) => (
          <GoalColumn
            key={status}
            status={status}
            rows={sortGoals(visible.filter((g) => g.status === status), view.sort)}
            canWrite={canWrite}
            sorted={view.sort !== "manual"}
            filterActive={filterActive}
            draggingId={draggingId}
            focusGoalId={focusGoalId}
            drop={drop}
            estimateTaskSize={props.estimateTaskSize}
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
// Learning — a radar of "how far am I from SOTA" per self-chosen domain,
// plus a thin task list of reps that should move those needles.
// The radar is a hand-rolled SVG (same approach as TrendChart further
// down — no charting dep) so it inherits the theme via currentColor.
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => Math.max(0, Math.min(100, n))

// Inline SVG radar — accepts the domain list and renders SOTA ring (always
// at the perimeter), the per-domain current polygon (filled), an optional
// target polygon (dashed outline). Axes are arranged starting at 12 o'clock
// and proceeding clockwise so the natural reading order matches.
// One axis on the radar — kept structural so the same component can be
// fed in-widget data or the build-time aggregate without an adapter.
interface RadarAxis {
  label: string
  current: number // 0–100
  target: number // 0–100
}

function LearningRadar(props: {
  axes: RadarAxis[]
  // total svg width — height auto-computed to leave room for the labels.
  width: number
}) {
  const t = useStrings()
  const gradId = useId()
  const n = props.axes.length
  // Reserve room around the polygon for axis labels.
  const pad = 38
  const w = props.width
  const h = w
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(cx, cy) - pad

  if (n < 3) {
    return <div className="dash-radar__hint">{t.radarHint}</div>
  }

  // θ_i — start at 12 o'clock and go clockwise. SVG y grows downward, so
  // "up" is -sin/-cos: we use the conventional polar with -π/2 offset.
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n
  const pt = (i: number, frac: number) => {
    const a = angle(i)
    return { x: cx + r * frac * Math.cos(a), y: cy + r * frac * Math.sin(a) }
  }

  // Grid: 4 concentric polygons at 25/50/75/100% of r.
  const grid = [0.25, 0.5, 0.75, 1].map((frac) => {
    const pts = Array.from({ length: n }, (_, i) => pt(i, frac))
    return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  })
  // Spokes — one per axis.
  const spokes = Array.from({ length: n }, (_, i) => pt(i, 1))
  // Filled "current" polygon and outlined "target" polygon.
  const currentPts = props.axes.map((d, i) => pt(i, clamp01(d.current) / 100))
  const targetPts = props.axes.map((d, i) => pt(i, clamp01(d.target) / 100))
  const poly = (pts: { x: number; y: number }[]) =>
    pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")

  // Label placement — slightly outside the outermost ring along each axis.
  const labels = props.axes.map((d, i) => {
    const a = angle(i)
    const lr = r + 14
    const x = cx + lr * Math.cos(a)
    const y = cy + lr * Math.sin(a)
    // Right-of-center labels: anchor start. Left: anchor end. Top/bottom: middle.
    const cos = Math.cos(a)
    const anchor: "middle" | "start" | "end" =
      Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end"
    return { x, y, anchor, label: d.label || "—", current: clamp01(d.current) }
  })

  return (
    <svg
      className="dash-radar"
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      role="img"
      aria-label={t.learningTitle}
    >
      <defs>
        <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.08" />
        </radialGradient>
      </defs>
      {/* grid rings */}
      {grid.map((pts, idx) => (
        <polygon
          key={idx}
          points={pts}
          fill="none"
          stroke="currentColor"
          strokeOpacity={idx === grid.length - 1 ? 0.5 : 0.15}
          strokeWidth={idx === grid.length - 1 ? 1.1 : 0.8}
        />
      ))}
      {/* spokes */}
      {spokes.map((p, i) => (
        <line
          key={i}
          x1={cx}
          y1={cy}
          x2={p.x}
          y2={p.y}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={0.8}
        />
      ))}
      {/* target polygon — outline only */}
      <polygon
        points={poly(targetPts)}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.5}
        strokeDasharray="4 3"
        strokeWidth={1.1}
      />
      {/* current polygon — filled */}
      <polygon
        points={poly(currentPts)}
        fill={`url(#${gradId})`}
        stroke="currentColor"
        strokeOpacity={0.85}
        strokeWidth={1.4}
      />
      {/* dots at each domain point so even a low score reads */}
      {currentPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.4} fill="currentColor" />
      ))}
      {/* labels */}
      {labels.map((l, i) => (
        <text
          key={i}
          x={l.x.toFixed(1)}
          y={l.y.toFixed(1)}
          textAnchor={l.anchor}
          dominantBaseline="middle"
          className="dash-radar__label"
          fill="currentColor"
        >
          {l.label}
          <tspan className="dash-radar__label-pct" dx="4" fill="currentColor" fillOpacity="0.55">
            {l.current}
          </tspan>
        </text>
      ))}
    </svg>
  )
}

// A horizontal progress bar — used inside the domain cards.
function ProgressBar(props: { value: number; max: number }) {
  const pct = props.max > 0 ? Math.max(0, Math.min(100, (props.value / props.max) * 100)) : 0
  return (
    <div className="dash-pbar" role="progressbar" aria-valuemin={0} aria-valuemax={props.max} aria-valuenow={props.value}>
      <div className="dash-pbar__fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

// One domain card on the dashboard summary — shows progress + subdomain
// breakdown. Card title links into the folder so the user can drill in.
function LearningDomainCard(props: { domain: AggLearningDomain }) {
  const { domain: d } = props
  return (
    <a className="dash-ldomain" href={`/${d.slug}/`}>
      <div className="dash-ldomain__head">
        <span className="dash-ldomain__label">{d.label}</span>
        <span className="dash-ldomain__pct">{d.stats.understood}%</span>
      </div>
      <ProgressBar value={d.stats.understood} max={100} />
      <div className="dash-ldomain__meta">
        {d.subdomains.length}领域 · {d.stats.read}/{d.stats.articles} 已读
        {d.stats.reading > 0 ? ` · ${d.stats.reading} 在读` : ""}
      </div>
      {d.subdomains.length > 0 && (
        <div className="dash-ldomain__subs">
          {d.subdomains.slice(0, 4).map((s) => (
            <span key={s.id} className="dash-ldomain__sub" title={`${s.stats.read}/${s.stats.articles}`}>
              {s.label}
              <span className="dash-ldomain__sub-pct">{s.stats.understood}%</span>
            </span>
          ))}
          {d.subdomains.length > 4 && (
            <span className="dash-ldomain__sub dash-ldomain__sub--more">
              +{d.subdomains.length - 4}
            </span>
          )}
        </div>
      )}
    </a>
  )
}

// Read-only learning section on the main dashboard. The folder tree
// (`content/dashboard/learning/**`) is the source of truth — the
// DashboardAggregate emitter walks it at build time, rolls up per
// domain / subdomain, and the section here just renders that picture.
// Editing happens by adding folders / .md files / frontmatter, or via
// the deeper hub pages (Phase 3).
function LearningSection(props: { learning: AggLearningTree | undefined }) {
  const t = useStrings()
  const learning = props.learning ?? { domains: [], stats: { articles: 0, read: 0, reading: 0, understood: 0 } }
  const { domains } = learning

  const axes: RadarAxis[] = domains.map((d) => ({
    label: d.label,
    current: d.stats.understood,
    target: d.target,
  }))

  // Average understanding across all articles (article-weighted), and
  // gap to SOTA = 100 - that. Tone watches against gap thresholds so a
  // huge unread surface jumps out.
  const understood = learning.stats.understood
  const gap = 100 - understood

  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>{t.learningTitle}</h2>
        <a className="dash-btn dash-btn--ghost" href="/dashboard/learning/">
          {t.learningOpenHub}
        </a>
      </div>
      <div className="dash-summary">
        <SummaryPill
          label={t.learningTitle}
          value={t.learningSummaryCount(domains.length)}
          tone="muted"
        />
        {learning.stats.articles > 0 && (
          <>
            <SummaryPill
              label={t.learningSummaryGap}
              value={`${gap}%`}
              tone={gap > 60 ? "warn" : gap > 30 ? "watch" : "good"}
            />
            <SummaryPill
              label={t.learningSummaryArticles}
              value={`${learning.stats.read}/${learning.stats.articles}`}
              tone="muted"
            />
          </>
        )}
      </div>

      {domains.length === 0 ? (
        <p className="dash-empty">
          {t.learningEmpty}
        </p>
      ) : (
        <div className="dash-learning">
          <div className="dash-learning__radar">
            <LearningRadar axes={axes} width={320} />
          </div>
          <div className="dash-learning__cards">
            {domains.map((d) => (
              <LearningDomainCard key={d.id} domain={d} />
            ))}
          </div>
        </div>
      )}
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
      <div className="dash-profile__caprow">
        <span className="dash-profile__caplabel">{t.profileWorkCapacityLabel}</span>
        {(["L", "M", "S"] as const).map((tier) => (
          <label key={tier} className="dash-profile__capcell">
            <span>{tier}</span>
            <input
              type="number"
              min={0}
              max={20}
              value={profile.workCapacity?.[tier] ?? 0}
              aria-label={`${t.profileWorkCapacityLabel} ${tier}`}
              onChange={(e) =>
                props.setProfile({
                  workCapacity: {
                    ...(profile.workCapacity ?? { L: 1, M: 1, S: 3 }),
                    [tier]: parseFloat(e.currentTarget.value) || 0,
                  },
                })
              }
            />
          </label>
        ))}
      </div>
      <div className="dash-profile__caprow">
        <span className="dash-profile__caplabel">{t.profilePersonalCapacityLabel}</span>
        {(["L", "M", "S"] as const).map((tier) => (
          <label key={tier} className="dash-profile__capcell">
            <span>{tier}</span>
            <input
              type="number"
              min={0}
              max={20}
              value={profile.personalCapacity?.[tier] ?? 0}
              aria-label={`${t.profilePersonalCapacityLabel} ${tier}`}
              onChange={(e) =>
                props.setProfile({
                  personalCapacity: {
                    ...(profile.personalCapacity ?? { L: 1, M: 1, S: 2 }),
                    [tier]: parseFloat(e.currentTarget.value) || 0,
                  },
                })
              }
            />
          </label>
        ))}
      </div>
      <p className="dash-profile__hint">{t.profileCapacityHint}</p>
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
// Daily archive sweep — health + tasks
//
// Two parallel flows:
//
//   Health: any weightLog / mealLog / exerciseLog entry dated before today
//           moves into dashboard/health/archive/<YYYY-MM>.runtime/data.json
//           (bucket = entry's `date`).
//
//   Tasks:  any goal with status=="done" + completedAt < today moves into
//           dashboard/tasks/archive/<YYYY-MM>.runtime/data.json
//           (bucket = goal's `completedAt`).
//
// The "今天" / "已完成" columns on the live panel stay focused on what
// happened today; everything older lives under /dashboard/.../archive/.
// Idempotent: archive month files are upserted with `add /<field>` of the
// whole merged-by-id list, so a repeat run on the same day is a no-op.
// ---------------------------------------------------------------------------

interface HealthMonthBucket {
  weightLog: WeightEntry[]
  mealLog: MealEntry[]
  exerciseLog: ExerciseEntry[]
}

interface TasksMonthBucket {
  goals: DashboardGoal[]
}

interface ArchiveResult {
  archivedCount: number
  updatedMonths: string[]
  trimmedData: DashboardData
}

// Read an existing archive month file. Returns the empty shape on 404 /
// network error so the merger can treat first-time and subsequent runs the
// same way.
async function readHealthMonth(month: string): Promise<HealthMonthBucket> {
  const empty: HealthMonthBucket = { weightLog: [], mealLog: [], exerciseLog: [] }
  try {
    const res = await fetch(`/dashboard/health/archive/${month}.runtime/data.json`, {
      cache: "no-cache",
    })
    if (!res.ok) return empty
    const raw = (await res.json()) as Partial<HealthMonthBucket>
    return {
      weightLog: Array.isArray(raw.weightLog) ? raw.weightLog : [],
      mealLog: Array.isArray(raw.mealLog) ? raw.mealLog : [],
      exerciseLog: Array.isArray(raw.exerciseLog) ? raw.exerciseLog : [],
    }
  } catch {
    return empty
  }
}

async function readTasksMonth(month: string): Promise<TasksMonthBucket> {
  const empty: TasksMonthBucket = { goals: [] }
  try {
    const res = await fetch(`/dashboard/tasks/archive/${month}.runtime/data.json`, {
      cache: "no-cache",
    })
    if (!res.ok) return empty
    const raw = (await res.json()) as Partial<TasksMonthBucket>
    return { goals: Array.isArray(raw.goals) ? raw.goals : [] }
  } catch {
    return empty
  }
}

function mergeById<T extends { id: string }>(have: T[], add: T[]): T[] {
  const seen = new Set(have.map((x) => x.id))
  const out = [...have]
  for (const a of add) if (!seen.has(a.id)) out.push(a)
  return out
}

async function runDailyArchive(opts: {
  data: DashboardData
  today: string
  workspaceId: string
}): Promise<ArchiveResult | null> {
  const { data, today, workspaceId } = opts
  const isOld = (date: string) => Boolean(date) && date < today
  const monthOf = (date: string) => date.slice(0, 7)

  // Health entries: filter by `date`.
  const oldW = data.weightLog.filter((w) => isOld(w.date))
  const oldM = data.mealLog.filter((m) => isOld(m.date))
  const oldE = data.exerciseLog.filter((e) => isOld(e.date))

  // Done goals with a finishing date older than today: filter by completedAt.
  const oldG = data.goals.filter((g) => g.status === "done" && isOld(g.completedAt))

  const total = oldW.length + oldM.length + oldE.length + oldG.length

  if (total === 0 && data.lastArchivedDate === today) return null
  if (total === 0) {
    return {
      archivedCount: 0,
      updatedMonths: [],
      trimmedData: { ...data, lastArchivedDate: today },
    }
  }

  // --- Health archive ------------------------------------------------------
  const healthMonths = new Set<string>()
  for (const x of oldW) healthMonths.add(monthOf(x.date))
  for (const x of oldM) healthMonths.add(monthOf(x.date))
  for (const x of oldE) healthMonths.add(monthOf(x.date))

  for (const month of healthMonths) {
    const existing = await readHealthMonth(month)
    const inThisMonth = (date: string) => monthOf(date) === month
    const mergedW = mergeById(existing.weightLog, oldW.filter((x) => inThisMonth(x.date)))
    const mergedM = mergeById(existing.mealLog, oldM.filter((x) => inThisMonth(x.date)))
    const mergedE = mergeById(existing.exerciseLog, oldE.filter((x) => inThisMonth(x.date)))
    mergedW.sort((a, b) => a.date.localeCompare(b.date))
    mergedM.sort((a, b) => a.date.localeCompare(b.date))
    mergedE.sort((a, b) => a.date.localeCompare(b.date))
    const result = await writeWidget("", {
      workspaceId,
      path: `dashboard/health/archive/${month}.runtime/data.json`,
      patch: [
        { op: "add", path: "/month", value: month },
        { op: "add", path: "/weightLog", value: mergedW },
        { op: "add", path: "/mealLog", value: mergedM },
        { op: "add", path: "/exerciseLog", value: mergedE },
      ],
      createIfMissing: true,
    })
    if (!result.ok) {
      throw new Error(
        `health archive write failed for ${month}: ${result.error?.message ?? "unknown"}`,
      )
    }
  }

  // --- Tasks archive -------------------------------------------------------
  const taskMonths = new Set<string>()
  for (const g of oldG) taskMonths.add(monthOf(g.completedAt))
  for (const month of taskMonths) {
    const existing = await readTasksMonth(month)
    const inThisMonth = (g: DashboardGoal) => monthOf(g.completedAt) === month
    const mergedG = mergeById(existing.goals, oldG.filter(inThisMonth))
    mergedG.sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    const result = await writeWidget("", {
      workspaceId,
      path: `dashboard/tasks/archive/${month}.runtime/data.json`,
      patch: [
        { op: "add", path: "/month", value: month },
        { op: "add", path: "/goals", value: mergedG },
      ],
      createIfMissing: true,
    })
    if (!result.ok) {
      throw new Error(
        `tasks archive write failed for ${month}: ${result.error?.message ?? "unknown"}`,
      )
    }
  }

  // --- Trim main data.json -------------------------------------------------
  const archivedIds = new Set<string>()
  for (const x of oldW) archivedIds.add(x.id)
  for (const x of oldM) archivedIds.add(x.id)
  for (const x of oldE) archivedIds.add(x.id)
  for (const x of oldG) archivedIds.add(x.id)
  const trimmedData: DashboardData = {
    ...data,
    weightLog: data.weightLog.filter((w) => !archivedIds.has(w.id)),
    mealLog: data.mealLog.filter((m) => !archivedIds.has(m.id)),
    exerciseLog: data.exerciseLog.filter((e) => !archivedIds.has(e.id)),
    goals: data.goals.filter((g) => !archivedIds.has(g.id)),
    lastArchivedDate: today,
  }
  const updatedMonths = [...new Set([...healthMonths, ...taskMonths])].sort()
  return { archivedCount: total, updatedMonths, trimmedData }
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
function Dashboard(props: {
  initialData: DashboardData
  canWrite: boolean
  bridgeOrigin: string
  workspaceId: string
  write: WidgetMountContext<DashboardData>["write"]
}) {
  const { canWrite, write, bridgeOrigin, workspaceId } = props
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

  // Daily archive — once per local day, on first mount, sweep stale entries
  // (older than ARCHIVE_WINDOW_DAYS) into per-month sidecars and trim
  // data.json. Runs once per Dashboard instance via the ref guard so a
  // language toggle or aggregate refetch doesn't re-trigger it.
  const [archiveStatus, setArchiveStatus] = useState<string | null>(null)
  const archiveRanRef = useRef(false)
  useEffect(() => {
    if (!canWrite || archiveRanRef.current) return
    archiveRanRef.current = true
    ;(async () => {
      try {
        const today = todayISO()
        const r = await runDailyArchive({ data: dataRef.current, today, workspaceId })
        if (!r) return // nothing to archive, date already stamped
        commit(() => r.trimmedData, [
          "weightLog",
          "mealLog",
          "exerciseLog",
          "goals",
          "lastArchivedDate",
        ])
        if (r.archivedCount > 0) {
          setArchiveStatus(
            `已归档 ${r.archivedCount} 条到 ${r.updatedMonths.join(" / ")}`,
          )
          window.setTimeout(() => setArchiveStatus(null), 5000)
        }
      } catch (e) {
        setArchiveStatus(`归档失败:${(e as Error).message}`)
        window.setTimeout(() => setArchiveStatus(null), 6000)
        archiveRanRef.current = false
      }
    })()
  }, [canWrite, commit, workspaceId])

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
    (status: GoalStatus) => {
      const goal: DashboardGoal = {
        id: `g-${Date.now()}`,
        title: "",
        note: "",
        status,
        priority: "none",
        tags: [],
        dueDate: "",
        log: [],
        kind: "personal",
        size: "",
        completedAt: "",
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
  // AI task-size estimate — feeds the goal card's ✨ button. Bridge
  // returns one of "S" | "M" | "L"; anything else means "couldn't tell".
  const estimateTaskSize = useCallback(
    async (title: string, note: string): Promise<GoalSize | null> => {
      if (!bridgeOrigin) return null
      try {
        const res = await fetch(`${bridgeOrigin}/api/tasks/estimate-size`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, note }),
        })
        if (!res.ok) return null
        const json = await res.json()
        const s = json?.size
        return s === "S" || s === "M" || s === "L" ? s : null
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
            {archiveStatus && <span className="dash-save dash-save--info">{archiveStatus}</span>}
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
          profile={data.profile}
          canWrite={canWrite}
          focusGoalId={focusGoalId}
          estimateTaskSize={bridgeOrigin ? estimateTaskSize : null}
          setGoals={setGoals}
          setView={setView}
          onAddGoal={addGoal}
        />
        <LearningSection learning={agg?.learning} />
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
      workspaceId: ctx.capabilities.workspaceId ?? "dashboard",
      write: ctx.write,
    }),
  )

  return () => {
    root.unmount()
    ctx.el.innerHTML = ""
  }
}
