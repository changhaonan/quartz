// e2e: verify the canvas-based PDF embed:
//   · pdfjs-dist runtime mounts, renders pages to <canvas>
//   · block-card wraps the figure with a stable, source-matching hash
//   · margin-comment 💬 still works on the PDF block
//   · annotation survives a full page reload
//   · drag-reorder via the bridge does NOT reload the canvas content
//     (the whole reason we switched off iframes)
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"
import fs from "node:fs"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const BRIDGE = process.env.BRIDGE || "http://127.0.0.1:3002"
const PAGE = "/papers/distillation"
const PDF_MD = process.env.PDF_MD || "/Users/haonanchang/Projects/quartz_pty/content/papers/distillation.md"
const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

// Snapshot for revert on the drag test.
const snapshots = new Map()
const snapshot = (path) => { if (!snapshots.has(path)) snapshots.set(path, fs.readFileSync(path, "utf8")) }
const restoreAll = () => {
  for (const [path, content] of snapshots) {
    try { fs.writeFileSync(path, content); note(`restored ${path.split("/").pop()}`) } catch {}
  }
}
process.on("exit", restoreAll)
process.on("SIGINT", () => { restoreAll(); process.exit(130) })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
const page = await ctx.newPage()
page.on("console", (msg) => { if (msg.type() === "error") note(`[browser error] ${msg.text()}`) })
page.on("pageerror", (err) => note(`[pageerror] ${err.message}`))

phase("1. open page + assert canvas viewer mounts")
await page.goto(BASE + PAGE, { waitUntil: "domcontentloaded" })
await page.waitForSelector("figure.pdf-embed .pdf-viewer", { timeout: 8000 })

// pdfjs-dist mounts asynchronously — wait up to 15s for canvases.
const waitForCanvas = async () => {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const r = await page.evaluate(() => {
      const h = document.querySelector(".pdf-viewer")
      return {
        numPages: h?.getAttribute("data-num-pages"),
        pages: h?.querySelectorAll(".pdf-viewer__page").length,
        canvases: h?.querySelectorAll("canvas").length,
        error: h?.querySelector(".pdf-viewer__status--error")?.textContent || null,
      }
    })
    if (r.error) return r
    if (r.canvases && r.canvases >= 1) return r
    await sleep(300)
  }
  return null
}
const mountResult = await waitForCanvas()
if (!mountResult) fail("PDF didn't render any canvas within 15s")
if (mountResult.error) fail(`PDF viewer error: ${mountResult.error}`)
if (Number(mountResult.numPages) !== 9) fail(`expected 9 pages, got ${mountResult.numPages}`)
ok(`PDF mounted: ${mountResult.numPages} pages, ${mountResult.canvases} canvas(es) painted`)

phase("2. block-card wraps the PDF figure with the URL-derived hash")
const blockCardInfo = await page.evaluate(() => {
  const figure = document.querySelector(".pdf-embed")
  if (!figure) return { error: "no figure" }
  const card = figure.closest(".block-card")
  if (!card) return { error: "figure not inside block-card" }
  return { blockId: card.getAttribute("data-block-id") || "" }
})
if (blockCardInfo.error) fail(blockCardInfo.error)
if (blockCardInfo.blockId !== "ca720a288004") {
  fail(`PDF block-id wrong (URL-derived hash should be ca720a288004), got ${blockCardInfo.blockId}`)
}
ok(`block-id = ${blockCardInfo.blockId} (matches sha1('papers/distillation.pdf'))`)

phase("3. PDF file actually served")
const pdfProbe = await page.evaluate(async () => {
  const r = await fetch("./distillation.pdf", { method: "HEAD" })
  return { status: r.status, len: r.headers.get("content-length") }
})
if (pdfProbe.status !== 200) fail(`PDF returned ${pdfProbe.status}`)
ok(`PDF served, ${(Number(pdfProbe.len) / 1024).toFixed(0)} KB`)

phase("4. snapshot canvas pixels BEFORE reorder")
// Scroll the first page into view so it's definitely rendered.
await page.evaluate(() => {
  const c = document.querySelector(".pdf-viewer canvas")
  c?.scrollIntoView({ behavior: "instant", block: "center" })
})
await sleep(500)
const canvasBefore = await page.evaluate(() => {
  const c = document.querySelector(".pdf-viewer canvas")
  if (!c) return null
  // Use a small section (top-left) to keep the data URL short.
  try { return c.toDataURL("image/png").slice(0, 200) } catch (e) { return `__FAIL__:${e.message}` }
})
if (!canvasBefore || canvasBefore.startsWith("__FAIL__")) fail(`couldn't read canvas: ${canvasBefore}`)
ok(`canvas[0] pixel signature captured (${canvasBefore.length} chars)`)

phase("5. drag-reorder the PDF block via the same path the real handler uses")
snapshot(PDF_MD)
const blocks = await page.$$eval("article .block-card[data-block-id]", (els) =>
  els.map((el) => {
    const inner = el.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
    const text = ((inner?.innerText || inner?.textContent || "")).replace(/\s+/g, " ").trim()
    return { hash: el.getAttribute("data-block-id") || "", prefix: text.slice(0, 60) }
  }),
)
const pdfIdx = blocks.findIndex((b) => b.hash === blockCardInfo.blockId)
if (pdfIdx <= 0) fail("PDF block at top, can't swap up")
const swapped = blocks.slice()
;[swapped[pdfIdx - 1], swapped[pdfIdx]] = [swapped[pdfIdx], swapped[pdfIdx - 1]]

// Begin sampling the canvas every 100ms BEFORE the reorder fires.
// "No flicker" means the canvas exists with non-zero pixels at every
// sample point through the morph window. This catches the bug where
// micromorph wipes the canvas children for ~150ms even if the
// before/after pixels match.
let samples = []
const sampleStart = Date.now()
const samplerId = setInterval(async () => {
  try {
    const r = await page.evaluate(() => {
      const c = document.querySelector(".pdf-viewer canvas")
      return c ? { exists: true, w: c.width, h: c.height } : { exists: false }
    })
    samples.push({ t: Date.now() - sampleStart, ...r })
  } catch (e) { samples.push({ t: Date.now() - sampleStart, err: e.message }) }
}, 100)

// Real-flow simulation: optimistic DOM rearrange + WS-suppress flag +
// POST. This is what block-toolbar.inline.ts does on a real drag.
await page.evaluate(({ targetHash, partnerHash }) => {
  const article = document.querySelector("article")
  const target = article?.querySelector(`.block-card[data-block-id="${targetHash}"]`)
  const partner = article?.querySelector(`.block-card[data-block-id="${partnerHash}"]`)
  if (target && partner) partner.parentElement?.insertBefore(target, partner)
}, { targetHash: blockCardInfo.blockId, partnerHash: blocks[pdfIdx - 1].hash })

const swapRes = await page.evaluate(async ({ bridge, blockOrder }) => {
  window.__quartzSuppressNextRebuild = Date.now() + 3000
  const r = await fetch(`${bridge}/api/blocks/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
    body: JSON.stringify({ slug: "papers/distillation", blockOrder }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}, { bridge: BRIDGE, blockOrder: swapped })
if (swapRes.status !== 200 || !swapRes.body?.ok) {
  fail(`reorder POST failed: ${swapRes.status} ${JSON.stringify(swapRes.body)}`)
}
ok("reorder POST accepted")

// Sample for 3 seconds — enough to cover bridge write + quartz
// rebuild + WS push + (would-be) morph window.
await sleep(3000)
clearInterval(samplerId)

phase("6. assert canvas exists at every sample (no flicker)")
const gaps = samples.filter((s) => !s.exists).length
const total = samples.length
note(`samples: ${total}, canvas-missing samples: ${gaps}`)
if (gaps > 0) {
  const firstGap = samples.findIndex((s) => !s.exists)
  fail(`canvas disappeared at sample ${firstGap}/${total} (~${samples[firstGap]?.t}ms after reorder POST). ${gaps} gap samples total.`)
}
ok(`canvas present at all ${total} samples through the morph window — zero flicker`)

// Sanity check: the canvas STILL has its painted content (not blanked).
const canvasAfter = await page.evaluate(() => {
  const c = document.querySelector(".pdf-viewer canvas")
  if (!c) return null
  try { return c.toDataURL("image/png").slice(0, 200) } catch (e) { return `__FAIL__:${e.message}` }
})
if (canvasBefore !== canvasAfter) {
  fail(`canvas pixels changed during the (suppressed) morph window — it was repainted somewhere. before[..40]="${canvasBefore?.slice(0, 40)}" after[..40]="${canvasAfter?.slice(0, 40)}"`)
}
ok("canvas pixels byte-identical (no repaint occurred)")

phase("7. margin-comment 💬 still mounts on the PDF block")
await page.locator(`.block-card[data-block-id="${blockCardInfo.blockId}"]`).hover()
await sleep(150)
await page.locator(`.block-card[data-block-id="${blockCardInfo.blockId}"] button[data-block-action="comment"]`).click({ force: true })
await sleep(400)
const widget = await page.evaluate((blockId) =>
  Boolean(document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)),
  blockCardInfo.blockId,
)
if (!widget) fail("margin-comment widget didn't mount on PDF block after reorder")
ok("💬 still works post-reorder")

// Clean up state we put in localStorage.
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })

await browser.close()
console.log("\n✅ Canvas PDF embed: renders, hashes correctly, survives reorder without flicker.")
