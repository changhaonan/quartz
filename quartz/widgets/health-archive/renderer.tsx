// Project jsxImportSource is preact (see tsconfig + esbuild config), so we
// match the runtime: preact for JSX + preact hooks + preact's `render`.
// The dashboard widget historically uses react-dom; we don't — fewer types
// to lie about, no cross-library VNode mismatch.
import { render } from "preact"
import { useEffect, useState } from "preact/hooks"
import type { WidgetMountContext } from "../types"
import type { HealthArchiveConfig } from "./schema"

// One day's row, mirroring dashboardAggregate.ts:HealthArchiveDay.
interface ArchiveDay {
  date: string
  weightKg: number | null
  intakeKcal: number
  exerciseKcal: number
  net: number
  mealCount: number
  exerciseCount: number
}
interface ArchiveMonth {
  month: string
  days: ArchiveDay[]
}
interface Aggregate {
  healthArchive?: { months?: ArchiveMonth[] }
}

function r0(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}
function fmtKg(n: number | null): string {
  if (n == null) return "—"
  return `${(Math.round(n * 10) / 10).toFixed(1)}`
}

// One <table> per month, newest first, days within newest first.
function MonthTable({ month }: { month: ArchiveMonth }) {
  if (month.days.length === 0) return null
  return (
    <section className="harchive__month">
      <h3 className="harchive__month-title">{month.month}</h3>
      <table className="harchive__table">
        <thead>
          <tr>
            <th>日期</th>
            <th>体重</th>
            <th>摄入</th>
            <th>运动</th>
            <th>明细</th>
          </tr>
        </thead>
        <tbody>
          {month.days.map((d) => (
            <tr key={d.date}>
              <td className="harchive__date">{d.date}</td>
              <td className="harchive__num">{d.weightKg != null ? `${fmtKg(d.weightKg)} kg` : "—"}</td>
              <td className="harchive__num">{r0(d.intakeKcal)} kcal</td>
              <td className="harchive__num">{r0(d.exerciseKcal)} kcal</td>
              <td className="harchive__detail">
                {d.mealCount} 餐 · {d.exerciseCount} 运动
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function HealthArchiveView() {
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
        setMonths(agg.healthArchive?.months ?? [])
      } catch (e) {
        if (!cancelled) setErr((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (err) {
    return <p className="harchive__empty">归档加载失败:{err}</p>
  }
  if (months === null) {
    return <p className="harchive__empty">加载中…</p>
  }
  if (months.length === 0) {
    return (
      <p className="harchive__empty">
        暂无归档。主面板每天首次打开会自动把昨天及更早的数据搬过来。
      </p>
    )
  }
  return (
    <div className="harchive">
      {months.map((m) => (
        <MonthTable key={m.month} month={m} />
      ))}
    </div>
  )
}

export function mountHealthArchive(ctx: WidgetMountContext<HealthArchiveConfig>): () => void {
  const host = document.createElement("div")
  host.className = "harchive-host"
  ctx.el.innerHTML = ""
  ctx.el.appendChild(host)
  render(<HealthArchiveView />, host)
  return () => {
    // preact unmount: render null into the same host clears the tree.
    render(null, host)
    ctx.el.innerHTML = ""
  }
}
