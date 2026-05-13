// Verify the new per-page PDF block runtime:
//   - each .pdf-viewer__page is wrapped in .block-card.block-card--pdf-page
//   - data-block-id is stable for a given (pdfSrc, pageNum)
//   - flex layout puts the canvas next to a .block-card__annotations slot
//   - the empty-state hint is present until a comment mounts
//   - expand/collapse toggle hides pages 2+ in collapsed mode
//
// Skips the actual ★ click (LLM call is slow + costs tokens). The
// extraction path is covered by a separate curl-based smoke in this
// session — here we just verify wiring.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const PAGE = process.env.PAGE || "/papers/distillation"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[browser err]", msg.text())
})

phase(`load ${BASE}${PAGE}`)
await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" })
// pdf-viewer kicks off mounting after networkidle; allow another tick
// for SubtleCrypto page-id derivation + appendChild loop.
await sleep(2000)

phase("per-page wrapper presence")
const pageCount = await page.locator("figure.pdf-embed .block-card.block-card--pdf-page").count()
if (pageCount < 1) fail(`expected at least 1 per-page block-card, got ${pageCount}`)
ok(`${pageCount} per-page cards rendered`)

phase("data-block-id stability across re-mount")
const ids1 = await page.locator(".block-card--pdf-page").evaluateAll((els) =>
  els.map((el) => el.getAttribute("data-block-id")),
)
if (ids1.length === 0 || ids1.some((id) => !id)) fail(`some cards missing data-block-id: ${JSON.stringify(ids1)}`)
ok(`block-ids: ${ids1.slice(0, 3).join(", ")}…`)
// Reload and confirm the SAME ids for the SAME pages.
await page.reload({ waitUntil: "domcontentloaded" })
await sleep(2000)
const ids2 = await page.locator(".block-card--pdf-page").evaluateAll((els) =>
  els.map((el) => el.getAttribute("data-block-id")),
)
if (JSON.stringify(ids1) !== JSON.stringify(ids2)) fail(`block-ids changed across reload: ${JSON.stringify(ids1)} → ${JSON.stringify(ids2)}`)
ok("block-ids stable across page reload")

phase("layout: canvas + annotation slot side-by-side (or stacked on narrow)")
const layout = await page.locator(".block-card--pdf-page").first().evaluate((el) => {
  const row = el.querySelector(".pdf-viewer__page-row")
  if (!row) return { ok: false, reason: "no .pdf-viewer__page-row" }
  const styles = window.getComputedStyle(row)
  const slot = el.querySelector(".block-card__annotations")
  if (!slot) return { ok: false, reason: "no .block-card__annotations" }
  const slotStyles = window.getComputedStyle(slot)
  return {
    ok: true,
    rowDisplay: styles.display,
    rowDirection: styles.flexDirection,
    slotWidth: slot.getBoundingClientRect().width,
    slotMinHeight: parseFloat(slotStyles.minHeight),
  }
})
if (!layout.ok) fail(`layout broken: ${layout.reason}`)
if (layout.rowDisplay !== "flex") fail(`row not flex: ${layout.rowDisplay}`)
if (layout.slotWidth < 50) fail(`annotation slot too narrow: ${layout.slotWidth}px`)
ok(`row display=${layout.rowDisplay} dir=${layout.rowDirection} slot=${Math.round(layout.slotWidth)}px h>=${layout.slotMinHeight}px`)

phase("empty-state hint visible before any annotation")
const emptyText = await page.locator(".block-card--pdf-page .block-card__annotations-empty").first().textContent()
if (!emptyText || !emptyText.includes("Jarvis")) fail(`empty-state hint missing or wrong: "${emptyText}"`)
ok(`empty-state present: "${emptyText.trim()}"`)

phase("toolbar buttons attached on per-page card")
const toolbar = await page.locator(".block-card--pdf-page").first().evaluate((el) => {
  const tb = el.querySelector(".block-card__toolbar")
  if (!tb) return { ok: false, reason: "no toolbar" }
  const actions = Array.from(tb.querySelectorAll("button[data-block-action]"))
    .map((b) => b.getAttribute("data-block-action"))
  return { ok: true, actions }
})
if (!toolbar.ok) fail(toolbar.reason)
const expected = ["copy", "comment", "jarvis-here"]
for (const a of expected) {
  if (!toolbar.actions.includes(a)) fail(`missing toolbar button: ${a}`)
}
if (toolbar.actions.includes("move")) fail(`per-page card should NOT have move button`)
ok(`toolbar actions: ${toolbar.actions.join(", ")}`)

phase("expand/collapse toggle")
const toggleExists = await page.locator(".pdf-embed__mode-toggle").count()
if (toggleExists < 1) fail("no expand/collapse toggle button found")
ok("toggle button present")
const beforeCollapse = await page.locator(".block-card--pdf-page:visible").count()
if (beforeCollapse < 2) fail(`expected multiple visible pages in expanded mode, got ${beforeCollapse}`)
ok(`${beforeCollapse} visible pages in expanded mode`)
await page.locator(".pdf-embed__mode-toggle").first().click()
await sleep(300)
const afterCollapse = await page.locator(".block-card--pdf-page:visible").count()
if (afterCollapse !== 1) fail(`expected 1 visible page in collapsed mode, got ${afterCollapse}`)
ok(`collapsed → ${afterCollapse} visible page`)
await page.locator(".pdf-embed__mode-toggle").first().click()
await sleep(300)
const reExpanded = await page.locator(".block-card--pdf-page:visible").count()
if (reExpanded !== beforeCollapse) fail(`re-expand did not restore: ${reExpanded} vs ${beforeCollapse}`)
ok(`re-expanded → ${reExpanded} visible pages`)

phase("data-pdf-page maps 1..N")
const pdfPages = await page.locator(".block-card--pdf-page").evaluateAll((els) =>
  els.map((el) => Number(el.getAttribute("data-pdf-page"))),
)
const expectedSeq = Array.from({ length: pdfPages.length }, (_, i) => i + 1)
if (JSON.stringify(pdfPages) !== JSON.stringify(expectedSeq)) {
  fail(`data-pdf-page sequence wrong: got ${JSON.stringify(pdfPages)} expected ${JSON.stringify(expectedSeq)}`)
}
ok(`page numbers: ${pdfPages.join(",")}`)

await browser.close()
console.log("\nALL CHECKS PASSED")
