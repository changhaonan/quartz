import fs from "fs"
import path from "path"
import matter from "gray-matter"
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

// --- Learning tree ---------------------------------------------------------
//
// Walks `content/dashboard/learning/**` and rolls up:
//   domain/         → has subdomains (folders) and a per-domain index
//     subdomain/    → has articles (leaf .md, non-index) and an index
//       article.md  → frontmatter is the source of truth for progress
//
// Each level's stats (article count, read count, mean understood) are
// pre-computed here so the widget reads a flat-ish shape, not a tree it
// has to traverse to render.

type ArticleStatus = "unread" | "reading" | "read"

interface LearningArticle {
  slug: string
  title: string
  status: ArticleStatus
  understood: number // 0–100
  source: string // optional external URL from frontmatter
}

interface LearningStats {
  // Totals for this node (counts every leaf article below it).
  articles: number
  read: number
  reading: number
  // Mean `understood` across articles below this node (0 if none).
  understood: number
}

interface LearningSubdomain {
  id: string
  label: string
  slug: string
  articles: LearningArticle[]
  stats: LearningStats
}

interface LearningDomainNode {
  id: string
  label: string
  slug: string
  target: number // optional frontmatter `target` on the domain index (default 100)
  subdomains: LearningSubdomain[]
  stats: LearningStats
}

interface LearningTree {
  domains: LearningDomainNode[]
  // Top-level totals — useful for the summary pill on the main dashboard.
  stats: LearningStats
}

// --- Health archive --------------------------------------------------------
//
// Walks `content/dashboard/health/archive/*.runtime/data.json` — each file
// is a monthly bucket the widget's daily archive sweep populates. The
// emitter pre-aggregates per-day rows so the archive viewer can render a
// "date / weight / intake / expenditure / net" table without re-summing in
// the browser.

interface HealthArchiveDay {
  date: string // YYYY-MM-DD
  weightKg: number | null
  intakeKcal: number
  exerciseKcal: number
  net: number // intake - exercise (BMR is profile-dependent, computed client-side if needed)
  mealCount: number
  exerciseCount: number
}

interface HealthArchiveMonth {
  month: string // YYYY-MM
  days: HealthArchiveDay[]
}

interface DashboardAggregate {
  generatedAt: string
  finance: { file: string | null; data: unknown | null; error: string | null }
  workflows: WorkflowSummary[]
  thoughts: { total: number; recent: ThoughtEntry[] }
  learning: LearningTree
  healthArchive: { months: HealthArchiveMonth[] }
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

// Read the frontmatter of a .md file, defensively — a malformed file
// shouldn't break the build.
function readFrontmatter(abs: string): Record<string, unknown> {
  try {
    const src = fs.readFileSync(abs, "utf8")
    const parsed = matter(src)
    return (parsed.data ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

function asStatus(v: unknown): ArticleStatus {
  return v === "read" || v === "reading" || v === "unread" ? v : "unread"
}
function asPct(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

// Roll a list of articles up into a stats block. Mean understood is over
// the whole bucket so a half-read 0%-understood article still drags the
// number down — that's the picture we want ("how much have you really
// internalised", not "of the ones you opened, how confident").
function rollupArticles(articles: LearningArticle[]): LearningStats {
  if (articles.length === 0) return { articles: 0, read: 0, reading: 0, understood: 0 }
  let read = 0
  let reading = 0
  let und = 0
  for (const a of articles) {
    if (a.status === "read") read++
    else if (a.status === "reading") reading++
    und += a.understood
  }
  return {
    articles: articles.length,
    read,
    reading,
    understood: Math.round(und / articles.length),
  }
}

function rollupSubdomains(subdomains: LearningSubdomain[]): LearningStats {
  // Concatenate every article across subdomains, then roll up — so the
  // domain mean is the article-weighted mean, not the mean of means.
  const all = subdomains.flatMap((s) => s.articles)
  return rollupArticles(all)
}

function collectLearning(contentRoot: string): LearningTree {
  const root = path.join(contentRoot, "dashboard", "learning")
  const exists = fs.existsSync(root) && fs.statSync(root).isDirectory()
  if (!exists) return { domains: [], stats: rollupArticles([]) }

  const slugOf = (abs: string): string => {
    const rel = path.relative(contentRoot, abs).split(path.sep).join("/")
    return slugifyFilePath(rel as FilePath)
  }

  // Layer 1: each subdir of learning/ is a domain.
  const domainEntries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))

  const domains: LearningDomainNode[] = []
  for (const dEntry of domainEntries) {
    const dDir = path.join(root, dEntry.name)
    const dIndex = path.join(dDir, "index.md")
    const dMeta = fs.existsSync(dIndex) ? readFrontmatter(dIndex) : {}
    const dLabel = (dMeta.title as string) || dEntry.name
    const dTarget = asPct((dMeta as { target?: unknown }).target ?? 100) || 100

    // Layer 2: each subdir of <domain>/ is a subdomain.
    const subEntries = fs
      .readdirSync(dDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))

    const subdomains: LearningSubdomain[] = []
    for (const sEntry of subEntries) {
      const sDir = path.join(dDir, sEntry.name)
      const sIndex = path.join(sDir, "index.md")
      const sMeta = fs.existsSync(sIndex) ? readFrontmatter(sIndex) : {}
      const sLabel = (sMeta.title as string) || sEntry.name

      // Layer 3: every .md in this dir, except index.md, is an article.
      let files: fs.Dirent[] = []
      try {
        files = fs.readdirSync(sDir, { withFileTypes: true })
      } catch {
        files = []
      }
      const articles: LearningArticle[] = []
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue
        if (f.name === "index.md") continue
        const abs = path.join(sDir, f.name)
        const meta = readFrontmatter(abs)
        articles.push({
          slug: slugOf(abs),
          title: (meta.title as string) || f.name.replace(/\.md$/, ""),
          status: asStatus(meta.status),
          understood: asPct(meta.understood),
          source: typeof meta.source === "string" ? meta.source : "",
        })
      }
      // Stable order: read & reading first by mtime-equivalent (title sort),
      // unread next. Within each group, by title.
      articles.sort((a, b) => a.title.localeCompare(b.title))

      subdomains.push({
        id: `${dEntry.name}/${sEntry.name}`,
        label: sLabel,
        slug: slugOf(sDir),
        articles,
        stats: rollupArticles(articles),
      })
    }
    subdomains.sort((a, b) => a.label.localeCompare(b.label))

    domains.push({
      id: dEntry.name,
      label: dLabel,
      slug: slugOf(dDir),
      target: dTarget,
      subdomains,
      stats: rollupSubdomains(subdomains),
    })
  }
  domains.sort((a, b) => a.label.localeCompare(b.label))

  // Tree-wide rollup: every article, everywhere.
  const allArticles = domains.flatMap((d) => d.subdomains.flatMap((s) => s.articles))
  return { domains, stats: rollupArticles(allArticles) }
}

function collectHealthArchive(contentRoot: string): DashboardAggregate["healthArchive"] {
  const archiveRoot = path.join(contentRoot, "dashboard", "health", "archive")
  if (!fs.existsSync(archiveRoot) || !fs.statSync(archiveRoot).isDirectory()) {
    return { months: [] }
  }
  const entries = fs.readdirSync(archiveRoot, { withFileTypes: true })
  const months: HealthArchiveMonth[] = []
  const MONTH_RE = /^\d{4}-\d{2}$/
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".runtime")) continue
    const month = entry.name.replace(/\.runtime$/, "")
    // Skip the index.runtime sidecar (widget-validation dummy) and any
    // other non-YYYY-MM bucket name.
    if (!MONTH_RE.test(month)) continue
    const dataPath = path.join(archiveRoot, entry.name, "data.json")
    let parsed: {
      weightLog?: { id: string; date: string; kg: number }[]
      mealLog?: { id: string; date: string; meal: string; food: string; kcal: number }[]
      exerciseLog?: { id: string; date: string; name: string; kcal: number }[]
    }
    try {
      parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"))
    } catch {
      continue
    }

    // Roll up per-day: one row per date with weight + summed kcal.
    const byDate = new Map<string, HealthArchiveDay>()
    const day = (date: string): HealthArchiveDay => {
      if (!byDate.has(date)) {
        byDate.set(date, {
          date,
          weightKg: null,
          intakeKcal: 0,
          exerciseKcal: 0,
          net: 0,
          mealCount: 0,
          exerciseCount: 0,
        })
      }
      return byDate.get(date)!
    }
    for (const w of parsed.weightLog ?? []) {
      if (!w.date) continue
      day(w.date).weightKg = typeof w.kg === "number" ? w.kg : null
    }
    for (const m of parsed.mealLog ?? []) {
      if (!m.date) continue
      const r = day(m.date)
      r.intakeKcal += Number.isFinite(m.kcal) ? Number(m.kcal) : 0
      r.mealCount += 1
    }
    for (const e of parsed.exerciseLog ?? []) {
      if (!e.date) continue
      const r = day(e.date)
      r.exerciseKcal += Number.isFinite(e.kcal) ? Number(e.kcal) : 0
      r.exerciseCount += 1
    }
    for (const r of byDate.values()) r.net = r.intakeKcal - r.exerciseKcal

    const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
    months.push({ month, days })
  }
  months.sort((a, b) => b.month.localeCompare(a.month))
  return { months }
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
    learning: collectLearning(contentRoot),
    healthArchive: collectHealthArchive(contentRoot),
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
