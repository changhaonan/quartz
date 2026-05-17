/** @jsxRuntime classic */
import React, { useCallback, useEffect, useId, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { JsonPatchOp, WidgetMountContext } from "../types"
import type {
  DashboardData,
  DashboardGoal,
  DashboardMetric,
  DashboardView,
  GoalCadence,
  GoalLogEntry,
  GoalPriority,
  GoalStatus,
} from "./schema"

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
  const d = new Date(iso)
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
  // Focus + select on mount — used for the row a "+ 添加" click just created
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
// Section: 目标 — a Notion-style board. Each cadence (每日 / 每周 / 主要) is a
// column; each goal is a card. Editing is in-place; a card is dragged between
// columns to change its cadence (the only way to re-bucket a goal).
// ---------------------------------------------------------------------------
const GOAL_GROUPS: Array<{ cadence: GoalCadence; label: string }> = [
  { cadence: "daily", label: "每日" },
  { cadence: "weekly", label: "每周" },
  { cadence: "main", label: "主要" },
]

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
const STATUS_OPTS: Array<{ value: GoalStatus; label: string }> = [
  { value: "todo", label: "未开始" },
  { value: "doing", label: "进行中" },
  { value: "done", label: "已完成" },
]

const PRIORITY_OPTS: Array<{ value: GoalPriority; label: string }> = [
  { value: "none", label: "优先级" },
  { value: "high", label: "高" },
  { value: "mid", label: "中" },
  { value: "low", label: "低" },
]

// --- Board view: filtering + sorting ---------------------------------------
const SORT_OPTS: Array<{ value: DashboardView["sort"]; label: string }> = [
  { value: "manual", label: "手动" },
  { value: "priority", label: "优先级" },
  { value: "dueDate", label: "截止日期" },
  { value: "status", label: "状态" },
]

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
  const { status, canWrite } = props
  if (!canWrite) {
    const o = STATUS_OPTS.find((x) => x.value === status) ?? STATUS_OPTS[0]
    return <span className={`dash-statpill dash-statpill--${status}`}>{o.label}</span>
  }
  return (
    <div className="dash-seg" role="group" aria-label="状态">
      {STATUS_OPTS.map((o) => (
        <button
          key={o.value}
          type="button"
          data-status={o.value}
          className={`dash-seg__btn dash-seg__btn--${o.value}${
            status === o.value ? " is-active" : ""
          }`}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
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
  const { tags, canWrite } = props
  const [input, setInput] = useState("")
  if (!canWrite) {
    if (tags.length === 0) return null
    return (
      <div className="dash-tags">
        {tags.map((t) => (
          <span className="dash-tag-chip" key={t}>
            #{t}
          </span>
        ))}
      </div>
    )
  }
  const add = () => {
    const t = input.trim()
    if (t && !tags.includes(t)) props.onChange([...tags, t])
    setInput("")
  }
  return (
    <div className="dash-tags">
      {tags.map((t) => (
        <span className="dash-tag-chip" key={t}>
          #{t}
          <button
            type="button"
            className="dash-tag-chip__x"
            aria-label={`移除标签 ${t}`}
            onClick={() => props.onChange(tags.filter((x) => x !== t))}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        className="dash-tag-input"
        value={input}
        placeholder="+ 标签"
        aria-label="添加标签"
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
// default (just a "进展 N" toggle) so cards stay compact; expand to read the
// history or append an entry.
function GoalLog(props: {
  entries: GoalLogEntry[]
  canWrite: boolean
  onChange: (entries: GoalLogEntry[]) => void
}) {
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
        进展{entries.length > 0 ? ` ${entries.length}` : ""}
      </button>
      {open && (
        <div className="dash-log-body">
          {canWrite && (
            <input
              className="dash-log-add"
              value={draft}
              placeholder="记录进展…"
              aria-label="记录进展"
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
            <p className="dash-log-empty">还没有进展记录。</p>
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
                        aria-label="删除这条进展"
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
  onPatch: (partial: Partial<DashboardGoal>) => void
  onRemove: () => void
  onDragStart: () => void
  onDragEnd: () => void
  // Cursor moved over this card during a drag — reports whether the drop would
  // land before this card or before the next one.
  onDragOver: (before: boolean) => void
}) {
  const { goal: g, canWrite, dragging, focus } = props
  const cardRef = useRef<HTMLDivElement>(null)
  const showProps = canWrite || g.priority !== "none" || Boolean(g.dueDate)

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
          title="拖动以在列间移动"
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
              placeholder="目标标题…"
              ariaLabel="目标标题"
              focusOnMount={focus}
              onCommit={(title) => props.onPatch({ title })}
            />
          ) : (
            <span className="dash-gcard__title">{g.title || "(未命名目标)"}</span>
          )}
          {canWrite && (
            <button className="dash-gcard__remove" title="删除目标" onClick={props.onRemove}>
              ✕
            </button>
          )}
        </div>

        {canWrite ? (
          <EditableField
            className="dash-gcard__note-input"
            value={g.note}
            placeholder="备注…"
            ariaLabel="目标备注"
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
                aria-label="优先级"
                onChange={(e) => props.onPatch({ priority: e.currentTarget.value as GoalPriority })}
              >
                {PRIORITY_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.value === "none" ? "优先级" : `优先级 · ${o.label}`}
                  </option>
                ))}
              </select>
            ) : (
              g.priority !== "none" && (
                <span className={`dash-priopill dash-priopill--${g.priority}`}>
                  {PRIORITY_OPTS.find((o) => o.value === g.priority)?.label}优先级
                </span>
              )
            )}
            {canWrite ? (
              <input
                className={`dash-date${g.dueDate ? " has-value" : ""}`}
                type="date"
                value={g.dueDate}
                aria-label="截止日期"
                onChange={(e) => props.onPatch({ dueDate: e.currentTarget.value })}
              />
            ) : (
              g.dueDate && <span className="dash-duepill">📅 {g.dueDate}</span>
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
  label: string
  rows: DashboardGoal[]
  canWrite: boolean
  // When a sort is active, within-column position is sort-determined: a drop
  // means "this column", so we suppress the between-cards drop indicator.
  sorted: boolean
  filterActive: boolean
  draggingId: string | null
  focusGoalId: string | null
  drop: DropTarget | null
  onCardPatch: (id: string, partial: Partial<DashboardGoal>) => void
  onRemove: (id: string) => void
  onAdd: (cadence: GoalCadence) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDropHint: (target: DropTarget) => void
  onDrop: () => void
}) {
  const { cadence, label, rows, canWrite, sorted, draggingId, focusGoalId, drop } = props
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
        <span className="dash-col__title">{label}</span>
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
            <p className="dash-empty">无匹配目标</p>
          ) : (
            !canWrite && <p className="dash-empty">还没有目标。</p>
          ))}
      </div>
      {canWrite && (
        <button className="dash-col__add" onClick={() => props.onAdd(cadence)}>
          + 添加
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
  // Mutate the goals array and persist.
  setGoals: (mutate: (goals: DashboardGoal[]) => DashboardGoal[]) => void
  // Patch the persisted view (filter / sort) state.
  setView: (partial: Partial<DashboardView>) => void
  onAddGoal: (cadence: GoalCadence) => void
}) {
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
  const hintDrop = (t: DropTarget) => {
    dropRef.current = t
    setDrop(t)
  }
  const endDrag = () => {
    dragIdRef.current = null
    dropRef.current = null
    setDraggingId(null)
    setDrop(null)
  }
  const handleDrop = () => {
    const id = dragIdRef.current
    const t = dropRef.current
    if (id && t) props.setGoals((gs) => moveGoal(gs, id, t.cadence, t.beforeId))
    endDrag()
  }

  // Tags present across all goals — populates the tag-filter dropdown.
  const allTags = [...new Set(goals.flatMap((g) => g.tags))].sort()
  const filterActive =
    view.filterStatus !== "all" || view.filterPriority !== "all" || view.filterTag !== ""
  const visible = goals.filter((g) => matchesView(g, view))

  return (
    <section className="dash-section">
      <div className="dash-section__head dash-section__head--board">
        <h2>目标</h2>
        {canWrite && (
          <div className="dash-board-toolbar">
            <select
              className="dash-vselect"
              aria-label="按状态筛选"
              value={view.filterStatus}
              onChange={(e) =>
                props.setView({
                  filterStatus: e.currentTarget.value as DashboardView["filterStatus"],
                })
              }
            >
              <option value="all">状态 · 全部</option>
              {STATUS_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  状态 · {o.label}
                </option>
              ))}
            </select>
            <select
              className="dash-vselect"
              aria-label="按优先级筛选"
              value={view.filterPriority}
              onChange={(e) =>
                props.setView({
                  filterPriority: e.currentTarget.value as DashboardView["filterPriority"],
                })
              }
            >
              <option value="all">优先级 · 全部</option>
              <option value="high">优先级 · 高</option>
              <option value="mid">优先级 · 中</option>
              <option value="low">优先级 · 低</option>
              <option value="none">优先级 · 无</option>
            </select>
            <select
              className="dash-vselect"
              aria-label="按标签筛选"
              value={view.filterTag}
              onChange={(e) => props.setView({ filterTag: e.currentTarget.value })}
            >
              <option value="">标签 · 全部</option>
              {/* A previously-set tag filter may no longer exist on any goal;
                  keep it as an option so the select still shows it. */}
              {!allTags.includes(view.filterTag) && view.filterTag !== "" && (
                <option value={view.filterTag}>标签 · #{view.filterTag}</option>
              )}
              {allTags.map((t) => (
                <option key={t} value={t}>
                  标签 · #{t}
                </option>
              ))}
            </select>
            <select
              className="dash-vselect"
              aria-label="排序"
              value={view.sort}
              onChange={(e) =>
                props.setView({ sort: e.currentTarget.value as DashboardView["sort"] })
              }
            >
              {SORT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  排序 · {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="dash-board">
        {GOAL_GROUPS.map(({ cadence, label }) => (
          <GoalColumn
            key={cadence}
            cadence={cadence}
            label={label}
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
// Section: 健康 — live Apple Health metrics, pushed from an iOS Shortcut to
// the bridge (POST /api/metrics/health) and fetched back here for the charts.
// ---------------------------------------------------------------------------
interface HealthSample {
  date: string
  weight?: number
  steps?: number
  sleepHours?: number
  restingHR?: number
}

const HEALTH_MINI_METRICS: Array<{
  key: "steps" | "sleepHours" | "restingHR"
  label: string
  unit: string
  digits: number
}> = [
  { key: "steps", label: "步数", unit: "", digits: 0 },
  { key: "sleepHours", label: "睡眠", unit: "h", digits: 1 },
  { key: "restingHR", label: "静息心率", unit: "bpm", digits: 0 },
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
  if (values.length < 2) {
    return <div className="dash-chart dash-chart--empty" style={{ height }} />
  }
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

function HealthSection(props: { samples: HealthSample[] | null; error: string | null }) {
  const { samples, error } = props

  if (error || samples === null || samples.length === 0) {
    return (
      <section className="dash-section">
        <h2>健康</h2>
        <p className="dash-empty">
          {error
            ? `无法读取健康数据:${error}。`
            : samples === null
              ? "加载健康数据中…"
              : "还没有健康数据。在 iPhone 上用「快捷指令」把体重等数据 POST 到 bridge 的 /api/metrics/health,刷新后即可在这里看到趋势。"}
        </p>
      </section>
    )
  }

  const seriesOf = (key: "weight" | "steps" | "sleepHours" | "restingHR"): number[] =>
    samples.map((s) => s[key]).filter((v): v is number => typeof v === "number")

  const weight = seriesOf("weight")
  const wLatest = weight[weight.length - 1]
  const wPrev = weight[weight.length - 2]
  const wDelta = wLatest != null && wPrev != null ? wLatest - wPrev : null

  return (
    <section className="dash-section">
      <h2>健康</h2>

      <div className="dash-health__hero">
        <div className="dash-health__hero-head">
          <span className="dash-health__label">体重</span>
          {wLatest != null ? (
            <>
              <span className="dash-health__value">
                {wLatest.toFixed(1)}
                <span className="dash-health__unit">kg</span>
              </span>
              {wDelta != null && Math.abs(wDelta) >= 0.05 && (
                <span className="dash-health__delta">
                  {wDelta > 0 ? "▲" : "▼"} {Math.abs(wDelta).toFixed(1)} kg
                </span>
              )}
            </>
          ) : (
            <span className="dash-health__value dash-health__value--muted">—</span>
          )}
        </div>
        <div className="dash-health__chart">
          <TrendChart values={weight.slice(-30)} height={76} fill />
        </div>
      </div>

      <div className="dash-health__grid">
        {HEALTH_MINI_METRICS.map((m) => {
          const vals = seriesOf(m.key)
          const latest = vals[vals.length - 1]
          return (
            <div className="dash-health__card" key={m.key}>
              <div className="dash-health__label">{m.label}</div>
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
                <TrendChart values={vals.slice(-20)} height={30} />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section: 财务 (read-only view of the latest weekly finance report)
// ---------------------------------------------------------------------------
function FinanceSection(props: { finance: Aggregate["finance"] }) {
  const fin = props.finance
  const d = fin?.data
  if (fin?.error) {
    return (
      <section className="dash-section">
        <h2>财务</h2>
        <p className="dash-empty">财务文件解析失败:{fin.error}</p>
      </section>
    )
  }
  if (!d) {
    return (
      <section className="dash-section">
        <h2>财务</h2>
        <p className="dash-empty">
          在 <code>content/.finance/</code> 放一份周报 JSON 即可显示。
        </p>
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
    { label: "现金 + 存款", value: money(acct?.cash_and_deposits?.total) },
    { label: "信用卡欠款", value: money(acct?.credit_cards?.total_current_balance), tone: "warn" },
    { label: "净现金", value: money(acct?.net_cash_after_credit_card_balances), tone: "good" },
    { label: "本周可控支出", value: money(sum?.controllable_spend_estimate) },
  ]

  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>财务</h2>
        {period?.label && (
          <span className="dash-tag">
            {period.label} · {fin?.file}
          </span>
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

      {Object.keys(targets).length > 0 && (
        <div className="dash-sub">
          <h3>周预算达成</h3>
          {Object.entries<any>(targets).map(([key, t]) => {
            const actual = Number(t?.actual ?? 0)
            const target = Number(t?.target ?? 0)
            const pct = target > 0 ? clampPct((actual / target) * 100) : 0
            const over = target > 0 && actual > target
            return (
              <div className="dash-target" key={key}>
                <span className="dash-target__label">{key}</span>
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
          <h3>即将到来的订阅</h3>
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

      {alerts.length > 0 && (
        <div className="dash-sub">
          <h3>提醒</h3>
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
// Section: 自定义指标卡 — in-place editable (label / value / unit / note are
// editable text fields). Adding a card appends an empty editable tile.
// ---------------------------------------------------------------------------
const TREND_GLYPH: Record<string, string> = { up: "▲", down: "▼", flat: "▬", none: "" }

function MetricsSection(props: {
  metrics: DashboardMetric[]
  canWrite: boolean
  focusMetricId: string | null
  setMetrics: (mutate: (metrics: DashboardMetric[]) => DashboardMetric[]) => void
  onAddMetric: () => void
}) {
  const { metrics, canWrite, focusMetricId } = props

  const patchMetric = (id: string, partial: Partial<DashboardMetric>) =>
    props.setMetrics((ms) => ms.map((m) => (m.id === id ? { ...m, ...partial } : m)))
  const removeMetric = (id: string) => props.setMetrics((ms) => ms.filter((m) => m.id !== id))

  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>自定义指标</h2>
        {canWrite && (
          <button className="dash-btn" onClick={props.onAddMetric}>
            + 添加指标
          </button>
        )}
      </div>
      {metrics.length === 0 && <p className="dash-empty">还没有指标卡。</p>}
      <div className="dash-stats">
        {metrics.map((m) => (
          <div className="dash-stat dash-stat--metric" key={m.id}>
            {canWrite ? (
              <>
                <button
                  className="dash-goal__remove dash-stat__remove"
                  title="删除指标"
                  onClick={() => removeMetric(m.id)}
                >
                  ✕
                </button>
                <div className="dash-stat__value-row">
                  <EditableField
                    className="dash-stat__value-input"
                    value={m.value}
                    placeholder="—"
                    ariaLabel="指标值"
                    onCommit={(value) => patchMetric(m.id, { value })}
                  />
                  <EditableField
                    className="dash-stat__unit-input"
                    value={m.unit}
                    placeholder="单位"
                    ariaLabel="单位"
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
                  placeholder="指标名称"
                  ariaLabel="指标名称"
                  focusOnMount={m.id === focusMetricId}
                  onCommit={(label) => patchMetric(m.id, { label })}
                />
                <EditableField
                  className="dash-stat__note-input"
                  value={m.note}
                  placeholder="备注…"
                  ariaLabel="指标备注"
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
// Section: Workflow 运行状态
// ---------------------------------------------------------------------------
function WorkflowsSection(props: { workflows: Aggregate["workflows"] }) {
  const wfs = props.workflows ?? []
  return (
    <section className="dash-section">
      <h2>Workflow 运行状态</h2>
      {wfs.length === 0 && <p className="dash-empty">未发现 workflow。</p>}
      <div className="dash-cards">
        {wfs.map((w) => (
          <a className="dash-card" href={`/${w.slug}`} key={w.slug}>
            <div className="dash-card__title">{w.name}</div>
            <div className="dash-card__meta">
              <span>{w.runCount} 次运行</span>
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
// Section: Thoughts / Diary 活动
// ---------------------------------------------------------------------------
function ThoughtsSection(props: { thoughts: Aggregate["thoughts"] }) {
  const t = props.thoughts ?? {}
  const recent = t.recent ?? []
  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>Thoughts / Diary 活动</h2>
        <span className="dash-tag">共 {t.total ?? 0} 条</span>
      </div>
      {recent.length === 0 && <p className="dash-empty">暂无记录。</p>}
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
// Section: Bridge sessions / tickets
// ---------------------------------------------------------------------------
function BridgeSection(props: { bridge: Aggregate["bridge"] }) {
  const b = props.bridge ?? {}
  const sessions = b.sessions ?? []
  const tickets = b.tickets ?? []
  return (
    <section className="dash-section">
      <div className="dash-section__head">
        <h2>Bridge</h2>
        <span className={`dash-pill dash-pill--${b.ok ? "ok" : "error"}`}>
          {b.ok ? "在线" : "离线"}
        </span>
      </div>
      {!b.ok && (
        <p className="dash-empty">
          无法连接 bridge ({b.origin}){b.error ? ` — ${b.error}` : ""}。
        </p>
      )}
      {b.ok && (
        <div className="dash-bridge">
          <div className="dash-sub">
            <h3>Sessions ({sessions.length})</h3>
            <ul className="dash-list">
              {sessions.map((s: any, idx: number) => (
                <li key={s?.sessionId ?? idx}>
                  <span className="dash-list__main">
                    {s?.role?.displayName || s?.kind || s?.sessionId}
                  </span>
                  <span className="dash-list__meta">{s?.state ?? s?.detectorState}</span>
                </li>
              ))}
              {sessions.length === 0 && <li className="dash-empty">无活跃 session</li>}
            </ul>
          </div>
          <div className="dash-sub">
            <h3>Tickets ({tickets.length})</h3>
            <ul className="dash-list">
              {tickets.slice(0, 8).map((t: any, idx: number) => (
                <li key={t?.id ?? idx}>
                  <span className="dash-list__main">{t?.summary || t?.title || t?.id}</span>
                  <span className={`dash-pill dash-pill--${t?.status ?? "open"}`}>
                    {t?.status ?? "—"}
                  </span>
                </li>
              ))}
              {tickets.length === 0 && <li className="dash-empty">无 ticket</li>}
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
  // The goal / metric a "+ 添加" click just created, so its first field can
  // grab focus on mount.
  const [focusGoalId, setFocusGoalId] = useState<string | null>(null)
  const [focusMetricId, setFocusMetricId] = useState<string | null>(null)

  // dataRef mirrors `data` synchronously so successive edits in the same tick
  // (e.g. blur-commit of a field immediately followed by another action)
  // always build on the latest state, not a stale render closure.
  const dataRef = useRef<DashboardData>(props.initialData)
  // lastSaved is the most recent server-confirmed state — the rollback target
  // if a write fails.
  const lastSaved = useRef<DashboardData>(props.initialData)
  // Writes coalesce: edits mark top-level keys dirty, a debounced flush sends
  // ONE request, and only one request is ever in flight. Without this, a
  // "+ 添加" write and the title-edit write that immediately follows it each
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
      setHealthErr("bridge 未配置")
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
  // `replace /<key>` of its freshest value (dataRef) — an idempotent,
  // index-free patch, so added/removed rows never desync from array indices.
  // Serialized: if a write is already in flight, this no-ops and the
  // in-flight write re-flushes on completion. On failure, roll back to the
  // last server-confirmed state and surface the error briefly.
  const flush = useCallback(() => {
    if (inFlight.current || dirty.current.size === 0) return
    const keys = [...dirty.current]
    dirty.current.clear()
    const snapshot = dataRef.current
    // `add` on an object member sets-or-replaces it (JSON Patch semantics),
    // so a top-level key that didn't exist yet (e.g. `view` in an older
    // data.json) is created rather than erroring like `replace` would.
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
        setWriteErr(r.error?.message ?? "保存失败")
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

  return (
    <div className="dashboard">
      {/* A plain div, not <header> — Quartz's content CSS gives the <header>
          element a 2rem block margin, which bloated this row. */}
      <div className="dash-header">
        <p className="dash-subtitle">
          {agg?.generatedAt
            ? `数据更新于 ${new Date(agg.generatedAt).toLocaleString()}`
            : "加载聚合数据中…"}
        </p>
        <div className="dash-header__actions">
          {writeErr && <span className="dash-save dash-save--error">保存失败:{writeErr}</span>}
          <button
            className="dash-btn"
            onClick={() => {
              void loadAggregate()
              void loadHealth()
            }}
          >
            ↻ 刷新
          </button>
        </div>
      </div>

      {aggErr && <p className="dash-empty">聚合数据加载失败:{aggErr}(站点重建后会自动生成)。</p>}

      <GoalsSection
        goals={data.goals}
        view={data.view}
        canWrite={canWrite}
        focusGoalId={focusGoalId}
        setGoals={setGoals}
        setView={setView}
        onAddGoal={addGoal}
      />
      <HealthSection samples={health} error={healthErr} />
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
