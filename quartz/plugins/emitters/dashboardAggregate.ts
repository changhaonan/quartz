import fs from "fs"
import path from "path"
import { QuartzEmitterPlugin } from "../types"
import { BuildCtx } from "../../util/ctx"
import { FilePath, FullSlug, slugifyFilePath } from "../../util/path"
import { write } from "./helpers"

// DashboardAggregate scans the content tree at build time and emits a single
// /dashboard-aggregate.json that the `dashboard` widget fetches at render
// time. Doing the aggregation here (rather than in the browser) keeps the
// bridge thin and sidesteps cross-origin reads: the site rebuilds on every
// content change, so the aggregate stays fresh without a server component.

const OUTPUT_SLUG = "dashboard-aggregate" as FullSlug

interface WorkflowSummary {
  name: string
  slug: string
  runCount: number
  latestRunId: string | null
  latestStatus: "ok" | "error" | "unknown" | null
}

interface ThoughtEntry {
  title: string
  slug: string
  mtime: string
}

interface DashboardAggregate {
  generatedAt: string
  finance: { file: string | null; data: unknown | null; error: string | null }
  workflows: WorkflowSummary[]
  thoughts: { total: number; recent: ThoughtEntry[] }
  bridge: {
    ok: boolean
    origin: string
    error: string | null
    sessions: unknown[]
    tickets: unknown[]
  }
}

// Recursively collect entries under `dir`, skipping the public output dir and
// VCS noise. Returns absolute paths.
function walk(dir: string, out: { dirs: string[]; files: string[] }): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      out.dirs.push(abs)
      walk(abs, out)
    } else if (entry.isFile()) {
      out.files.push(abs)
    }
  }
}

function toSlug(contentRoot: string, abs: string): string {
  const rel = path.relative(contentRoot, abs).split(path.sep).join("/")
  return slugifyFilePath(rel as FilePath)
}

function collectFinance(contentRoot: string): DashboardAggregate["finance"] {
  const financeDir = path.join(contentRoot, ".finance")
  let files: string[]
  try {
    files = fs
      .readdirSync(financeDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(financeDir, f))
  } catch {
    return { file: null, data: null, error: null }
  }
  if (files.length === 0) return { file: null, data: null, error: null }

  // Pick the most recently modified report — finance files are weekly
  // snapshots (MM_DD.json) and mtime is the most reliable "latest" signal.
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const latest = files[0]
  try {
    const data = JSON.parse(fs.readFileSync(latest, "utf8"))
    return { file: path.basename(latest), data, error: null }
  } catch (e) {
    return { file: path.basename(latest), data: null, error: (e as Error).message }
  }
}

function collectWorkflows(
  contentRoot: string,
  dirs: string[],
): WorkflowSummary[] {
  const workflows: WorkflowSummary[] = []
  for (const dir of dirs) {
    if (!dir.endsWith(".runtime")) continue
    const wfFile = path.join(dir, "workflow.json")
    if (!fs.existsSync(wfFile)) continue

    const base = path.basename(dir).replace(/\.runtime$/, "")
    const parentRel = path.relative(contentRoot, path.dirname(dir))
    const slug = slugifyFilePath(
      (parentRel ? `${parentRel}/${base}.md` : `${base}.md`) as FilePath,
    )

    let runCount = 0
    let latestRunId: string | null = null
    let latestStatus: WorkflowSummary["latestStatus"] = null
    const runsDir = path.join(dir, "runs")
    try {
      const runDirs = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
      runCount = runDirs.length
      if (runCount > 0) {
        latestRunId = runDirs[runDirs.length - 1]
        const resultFile = path.join(runsDir, latestRunId, "result.json")
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, "utf8"))
          latestStatus = result?.ok === true ? "ok" : result?.ok === false ? "error" : "unknown"
        } catch {
          latestStatus = "unknown"
        }
      }
    } catch {
      // No runs/ directory yet — workflow defined but never executed.
    }

    workflows.push({ name: base, slug, runCount, latestRunId, latestStatus })
  }
  workflows.sort((a, b) => a.name.localeCompare(b.name))
  return workflows
}

function collectThoughts(
  contentRoot: string,
  files: string[],
): DashboardAggregate["thoughts"] {
  // Dated note captures live under Thoughts/ and Diary/. Skip index/landing
  // pages — only count actual entries.
  const entries: { abs: string; mtime: number }[] = []
  for (const abs of files) {
    if (!abs.endsWith(".md")) continue
    const rel = path.relative(contentRoot, abs).split(path.sep).join("/")
    const inThoughts = rel === "Thoughts" || rel.startsWith("Thoughts/")
    const inDiary = rel === "Diary" || rel.startsWith("Diary/")
    if (!inThoughts && !inDiary) continue
    const base = path.basename(abs, ".md")
    if (base === "index") continue
    try {
      entries.push({ abs, mtime: fs.statSync(abs).mtimeMs })
    } catch {}
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  const recent: ThoughtEntry[] = entries.slice(0, 8).map((e) => ({
    title: path.basename(e.abs, ".md"),
    slug: toSlug(contentRoot, e.abs),
    mtime: new Date(e.mtime).toISOString(),
  }))
  return { total: entries.length, recent }
}

async function collectBridge(): Promise<DashboardAggregate["bridge"]> {
  const origin = process.env.WORKFLOW_BRIDGE_URL ?? "http://127.0.0.1:3210"
  const result: DashboardAggregate["bridge"] = {
    ok: false,
    origin,
    error: null,
    sessions: [],
    tickets: [],
  }

  const fetchJson = async (url: string): Promise<any> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const health = await fetchJson(`${origin}/api/health`)
    result.ok = true
    result.sessions = Array.isArray(health?.sessions) ? health.sessions : []
  } catch (e) {
    result.error = (e as Error).message
    return result
  }

  try {
    const tickets = await fetchJson(`${origin}/api/tickets`)
    result.tickets = Array.isArray(tickets?.tickets) ? tickets.tickets : []
  } catch {
    // Health succeeded but tickets failed — keep the partial snapshot.
  }
  return result
}

async function generate(ctx: BuildCtx): Promise<DashboardAggregate> {
  const contentRoot = path.resolve(ctx.argv.directory)
  const collected = { dirs: [] as string[], files: [] as string[] }
  walk(contentRoot, collected)

  return {
    generatedAt: new Date().toISOString(),
    finance: collectFinance(contentRoot),
    workflows: collectWorkflows(contentRoot, collected.dirs),
    thoughts: collectThoughts(contentRoot, collected.files),
    bridge: await collectBridge(),
  }
}

export const DashboardAggregate: QuartzEmitterPlugin = () => {
  return {
    name: "DashboardAggregate",
    async *emit(ctx) {
      const aggregate = await generate(ctx)
      yield write({
        ctx,
        slug: OUTPUT_SLUG,
        ext: ".json",
        content: JSON.stringify(aggregate, null, 2),
      })
    },
    // Regenerate fully on any content change. The aggregate is cheap to
    // compute and any md/json/runtime change can shift what it reports.
    async *partialEmit(ctx) {
      const aggregate = await generate(ctx)
      yield write({
        ctx,
        slug: OUTPUT_SLUG,
        ext: ".json",
        content: JSON.stringify(aggregate, null, 2),
      })
    },
  }
}
