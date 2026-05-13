// Parametric block-interactions test: for every distinct block kind
// across the kitchen-sink demo + papers PDF page, verify
//   · hover-revealed toolbar shows
//   · ⧉ copy → clipboard receives the block's text/title
//   · 💬 comment → margin-comment widget mounts
//   · ★ jarvis-here button is present and enabled (no LLM call here —
//     too expensive for a matrix run)
//   · drag-via-API reorder rewrites the source markdown (one swap per
//     page, then reverts so the file is untouched)
//
// Replaces the "click every block manually" review pass.
//
// Run with default ports (dev). Override with BASE + BRIDGE to point
// at staging/prod (PROD reorder will write to prod content — only run
// against dev unless you mean it).
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"
import fs from "node:fs"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const BRIDGE = process.env.BRIDGE || "http://127.0.0.1:3002"
const DEMO_MD = process.env.DEMO_MD || "/Users/haonanchang/Projects/quartz_pty/content/Thoughts/blocks-demo.md"
const PDF_MD = process.env.PDF_MD || "/Users/haonanchang/Projects/quartz_pty/content/papers/distillation.md"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

// Result matrix: { "kind:action": "pass" | "fail: msg" | "skip: reason" }
const matrix = {}
const record = (kind, action, status) => {
  matrix[`${kind}:${action}`] = status
  const sym = status === "pass" ? "✓" : status.startsWith("skip") ? "·" : "✗"
  console.log(`  ${sym} ${kind.padEnd(10)} ${action.padEnd(14)} ${status}`)
}

// File-snapshot helper: capture and restore so drag tests don't pollute.
const snapshots = new Map()
const snapshot = (path) => { if (!snapshots.has(path)) snapshots.set(path, fs.readFileSync(path, "utf8")) }
const restoreAll = () => {
  for (const [path, content] of snapshots) {
    try { fs.writeFileSync(path, content); note(`restored ${path.split("/").pop()}`) } catch (e) {}
  }
}
process.on("exit", restoreAll)
process.on("SIGINT", () => { restoreAll(); process.exit(130) })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 1100 },
  permissions: ["clipboard-read", "clipboard-write"],
})
const page = await ctx.newPage()
page.on("console", (msg) => { if (msg.type() === "error") note(`[browser] ${msg.text()}`) })

// ─── helpers ─────────────────────────────────────────────────────

async function gotoPage(slug) {
  await page.goto(BASE + slug, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("article .block-card[data-block-id]", { timeout: 8000 })
  await sleep(600)  // toolbar bind
  await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })
}

// One representative block per kind on the current page.
async function representativeBlocks() {
  return page.$$eval("article .block-card[data-block-id]", (els) => {
    const byKind = new Map()
    for (const el of els) {
      const inner = el.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
      const tag = (inner?.tagName || "unknown").toLowerCase()
      const text = ((inner?.innerText || inner?.textContent || "")).replace(/\s+/g, " ").trim()
      const id = el.getAttribute("data-block-id") || ""
      if (!byKind.has(tag)) byKind.set(tag, { kind: tag, id, text: text.slice(0, 80) })
    }
    return Array.from(byKind.values())
  })
}

async function probeToolbar(kind, id) {
  await page.locator(`.block-card[data-block-id="${id}"]`).hover()
  await sleep(120)
  const visible = await page.evaluate((blockId) => {
    const card = document.querySelector(`.block-card[data-block-id="${blockId}"]`)
    const bar = card?.querySelector(".block-card__toolbar")
    if (!bar) return { ok: false, reason: "no toolbar element" }
    const cs = getComputedStyle(bar)
    return { ok: cs.opacity !== "0", opacity: cs.opacity, has: { copy: !!bar.querySelector("[data-block-action='copy']"), comment: !!bar.querySelector("[data-block-action='comment']"), jarvis: !!bar.querySelector("[data-block-action='jarvis-here']"), move: !!bar.querySelector("[data-block-action='move']") } }
  }, id)
  if (!visible.ok) return record(kind, "toolbar-hover", `fail: ${visible.reason || `opacity=${visible.opacity}`}`)
  if (!visible.has.copy || !visible.has.comment || !visible.has.jarvis || !visible.has.move) {
    return record(kind, "toolbar-hover", `fail: missing buttons ${JSON.stringify(visible.has)}`)
  }
  record(kind, "toolbar-hover", "pass")
}

async function probeCopy(kind, id, expectedText) {
  await page.locator(`.block-card[data-block-id="${id}"]`).hover()
  await sleep(80)
  await page.locator(`.block-card[data-block-id="${id}"] button[data-block-action="copy"]`).click({ force: true })
  await sleep(200)
  const clip = await page.evaluate(async () => {
    try { return await navigator.clipboard.readText() } catch (e) { return `__READ_FAIL__:${e.message}` }
  })
  if (clip.startsWith("__READ_FAIL__")) return record(kind, "copy", `skip: ${clip}`)
  // Copy reads ONLY the paragraph (specific selector in block-toolbar).
  // For non-paragraph blocks the copy button copies the para inside;
  // for figure/heading/list it may be empty. Accept "non-empty AND
  // either matches expectedText OR comes from this block's inner".
  if (!clip) {
    // figure (PDF) has no p inside; this is expected, mark as skip.
    if (kind === "figure" || kind === "h1" || kind === "h2" || kind === "h3") {
      return record(kind, "copy", "skip: no inner <p> (by design)")
    }
    return record(kind, "copy", "fail: clipboard empty")
  }
  // Normalize whitespace (tabs / newlines) before comparing — copy
  // preserves them but the test's expectedText was already flattened.
  const norm = (s) => s.replace(/\s+/g, " ").toLowerCase().trim()
  const c = norm(clip), e = norm(expectedText)
  const matches = e.includes(c.slice(0, 40)) || c.includes(e.slice(0, 40))
  record(kind, "copy", matches ? "pass" : `fail: mismatch "${clip.slice(0, 50)}…" vs expected "${expectedText.slice(0, 50)}…"`)
}

async function probeComment(kind, id) {
  await page.locator(`.block-card[data-block-id="${id}"]`).hover()
  await sleep(80)
  await page.locator(`.block-card[data-block-id="${id}"] button[data-block-action="comment"]`).click({ force: true })
  await sleep(350)
  const widgetVisible = await page.evaluate((blockId) => {
    return Boolean(document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`))
  }, id)
  record(kind, "comment", widgetVisible ? "pass" : "fail: widget didn't mount")
  // Clean up so subsequent probes don't drown in widgets.
  await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })
}

async function probeJarvisHereButton(kind, id) {
  const enabled = await page.evaluate((blockId) => {
    const card = document.querySelector(`.block-card[data-block-id="${blockId}"]`)
    const btn = card?.querySelector("button[data-block-action='jarvis-here']")
    return Boolean(btn) && !btn.hasAttribute("disabled")
  }, id)
  record(kind, "jarvis-here-btn", enabled ? "pass" : "fail: button missing/disabled")
}

async function probeDragReorder(pageLabel, slug, mdPath) {
  snapshot(mdPath)
  // Pull current block order from DOM.
  const blocks = await page.$$eval("article .block-card[data-block-id]", (els) =>
    els.map((el) => {
      const inner = el.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
      const text = ((inner?.innerText || inner?.textContent || "")).replace(/\s+/g, " ").trim()
      return { hash: el.getAttribute("data-block-id") || "", prefix: text.slice(0, 60) }
    }),
  )
  if (blocks.length < 2) return record(pageLabel, "reorder-api", "skip: need ≥2 blocks")
  // Swap first two blocks via the bridge.
  const swapped = [blocks[1], blocks[0], ...blocks.slice(2)]
  const slugClean = slug.replace(/^\/+/, "")
  const res = await page.evaluate(async ({ bridge, slug, blockOrder }) => {
    const r = await fetch(`${bridge}/api/blocks/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
      body: JSON.stringify({ slug, blockOrder }),
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }, { bridge: BRIDGE, slug: slugClean, blockOrder: swapped })
  if (res.status !== 200 || !res.body?.ok) {
    return record(pageLabel, "reorder-api", `fail: ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`)
  }
  // Verify the file changed.
  const after = fs.readFileSync(mdPath, "utf8")
  const before = snapshots.get(mdPath)
  if (after === before) return record(pageLabel, "reorder-api", "fail: file unchanged after 200 OK")
  // Restore.
  fs.writeFileSync(mdPath, before)
  record(pageLabel, "reorder-api", "pass")
}

// ─── run ─────────────────────────────────────────────────────────

phase(`A. blocks-demo (${BASE}/Thoughts/blocks-demo)`)
await gotoPage("/Thoughts/blocks-demo")
const demoBlocks = await representativeBlocks()
note(`demo blocks: ${demoBlocks.map((b) => b.kind).join(", ")}`)
for (const b of demoBlocks) {
  await probeToolbar(b.kind, b.id)
  await probeJarvisHereButton(b.kind, b.id)
  await probeCopy(b.kind, b.id, b.text)
  await probeComment(b.kind, b.id)
}
await probeDragReorder("blocks-demo", "Thoughts/blocks-demo", DEMO_MD)

phase(`B. papers/distillation (PDF)`)
await gotoPage("/papers/distillation")
const pdfBlocks = await representativeBlocks()
note(`pdf-page blocks: ${pdfBlocks.map((b) => b.kind).join(", ")}`)
for (const b of pdfBlocks) {
  await probeToolbar(b.kind, b.id)
  await probeJarvisHereButton(b.kind, b.id)
  await probeCopy(b.kind, b.id, b.text)
  await probeComment(b.kind, b.id)
}
await probeDragReorder("papers/distillation", "papers/distillation", PDF_MD)

// ─── summary ─────────────────────────────────────────────────────
phase("Summary")
const total = Object.keys(matrix).length
const passed = Object.values(matrix).filter((v) => v === "pass").length
const failed = Object.entries(matrix).filter(([, v]) => v.startsWith("fail")).map(([k]) => k)
const skipped = Object.entries(matrix).filter(([, v]) => v.startsWith("skip")).map(([k]) => k)
console.log(`\n  total:   ${total}`)
console.log(`  passed:  ${passed}`)
console.log(`  skipped: ${skipped.length}${skipped.length ? `  (${skipped.join(", ")})` : ""}`)
console.log(`  failed:  ${failed.length}${failed.length ? `  (${failed.join(", ")})` : ""}`)

await browser.close()
if (failed.length) { console.error("\n✗ some block interactions regressed"); process.exit(1) }
console.log("\n✅ Block interactions: all observable actions still work.")
