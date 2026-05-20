// Project jsxImportSource is preact — match the runtime.
import { render } from "preact"
import { useEffect, useState } from "preact/hooks"
import type { WidgetMountContext } from "../types"
import type { TasksArchiveConfig } from "./schema"

interface ArchivedGoal {
  id: string
  title: string
  note: string
  status: string
  priority: string
  tags: string[]
  dueDate: string
  kind: string
  size: string
  completedAt: string
}
interface ArchiveMonth {
  month: string
  goals: ArchivedGoal[]
}
interface Aggregate {
  tasksArchive?: { months?: ArchiveMonth[] }
}

const SIZE_LABEL: Record<string, string> = { S: "小", M: "中", L: "大" }
const KIND_LABEL: Record<string, string> = { personal: "个人", work: "工作" }

function GoalCard({ g }: { g: ArchivedGoal }) {
  return (
    <li className="tarchive__goal">
      <div className="tarchive__goal-head">
        <span className="tarchive__goal-title">{g.title || "(未命名)"}</span>
        <span className="tarchive__goal-date">{g.completedAt}</span>
      </div>
      {g.note && <p className="tarchive__goal-note">{g.note}</p>}
      <div className="tarchive__goal-meta">
        {g.kind && <span className="tarchive__chip">{KIND_LABEL[g.kind] ?? g.kind}</span>}
        {g.size && SIZE_LABEL[g.size] && (
          <span className="tarchive__chip">{SIZE_LABEL[g.size]}</span>
        )}
        {g.tags.map((t) => (
          <span key={t} className="tarchive__chip tarchive__chip--tag">#{t}</span>
        ))}
      </div>
    </li>
  )
}

function MonthBlock({ month }: { month: ArchiveMonth }) {
  if (month.goals.length === 0) return null
  return (
    <section className="tarchive__month">
      <h3 className="tarchive__month-title">
        {month.month} <span className="tarchive__count">· {month.goals.length} 件</span>
      </h3>
      <ul className="tarchive__list">
        {month.goals.map((g) => (
          <GoalCard key={g.id} g={g} />
        ))}
      </ul>
    </section>
  )
}

function TasksArchiveView() {
  const [months, setMonths] = useState<ArchiveMonth[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/dashboard-aggregate.json", { cache: "no-cache" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const agg = (await res.json()) as Aggregate
        if (cancelled) return
        setMonths(agg.tasksArchive?.months ?? [])
      } catch (e) {
        if (!cancelled) setErr((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (err) return <p className="tarchive__empty">归档加载失败:{err}</p>
  if (months === null) return <p className="tarchive__empty">加载中…</p>
  if (months.length === 0) {
    return (
      <p className="tarchive__empty">
        暂无归档。主面板的目标拖到"已完成"列后,从第二天起会按月归档到这里。
      </p>
    )
  }
  return (
    <div className="tarchive">
      {months.map((m) => (
        <MonthBlock key={m.month} month={m} />
      ))}
    </div>
  )
}

export function mountTasksArchive(ctx: WidgetMountContext<TasksArchiveConfig>): () => void {
  const host = document.createElement("div")
  host.className = "tarchive-host"
  ctx.el.innerHTML = ""
  ctx.el.appendChild(host)
  render(<TasksArchiveView />, host)
  return () => {
    render(null, host)
    ctx.el.innerHTML = ""
  }
}
