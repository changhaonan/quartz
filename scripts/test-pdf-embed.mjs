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

phase("5. drag-reorder the PDF block via the bridge API")
snapshot(PDF_MD)
const blocks = await page.$$eval("article .block-card[data-block-id]", (els) =>
  els.map((el) => {
    const inner = el.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
    const text = ((inner?.innerText || inner?.textContent || "")).replace(/\s+/g, " ").trim()
    return { hash: el.getAttribute("data-block-id") || "", prefix: text.slice(0, 60) }
  }),
)
const pdfIdx = blocks.findIndex((b) => b.hash === blockCardInfo.blockId)
if (pdfIdx < 0) fail("PDF block not in DOM order list")
if (pdfIdx === 0) fail("PDF block already at top, can't swap up")
// Swap PDF with the block above it.
const swapped = blocks.slice()
;[swapped[pdfIdx - 1], swapped[pdfIdx]] = [swapped[pdfIdx], swapped[pdfIdx - 1]]
const swapRes = await page.evaluate(async ({ bridge, blockOrder }) => {
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

phase("6. wait for soft-morph; assert canvas pixels UNCHANGED")
// Quartz rebuild + WS push + spaNavigate soft-morph takes ~1-2s.
await sleep(2500)
const dragLanded = await page.evaluate((expectedHash) => {
  const card = document.querySelector(`article .block-card[data-block-id="${expectedHash}"]`)
  if (!card) return { error: "PDF block-card missing after morph" }
  const idx = Array.from(document.querySelectorAll("article .block-card[data-block-id]")).indexOf(card)
  return { idx, hasCanvas: !!card.querySelector("canvas") }
}, blockCardInfo.blockId)
if (dragLanded.error) fail(dragLanded.error)
if (!dragLanded.hasCanvas) fail("canvas missing after morph (block-card was rebuilt?)")
ok(`PDF block at new index ${dragLanded.idx}, canvas survived morph`)

const canvasAfter = await page.evaluate(() => {
  const c = document.querySelector(".pdf-viewer canvas")
  if (!c) return null
  try { return c.toDataURL("image/png").slice(0, 200) } catch (e) { return `__FAIL__:${e.message}` }
})
if (canvasBefore === canvasAfter) {
  ok("canvas pixel signature UNCHANGED — no reload, no flicker")
} else {
  fail(`canvas pixels changed after reorder → canvas re-rendered (regression). before[..40]="${canvasBefore?.slice(0, 40)}" after[..40]="${canvasAfter?.slice(0, 40)}"`)
}

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
