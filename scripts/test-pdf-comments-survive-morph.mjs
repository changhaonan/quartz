// Reproduce + verify the fix for: "PDF block moves but its per-page
// comments don't move with it" (the runtime-added .block-card--pdf-page
// cards get stripped by micromorph during a block-reorder soft-rebuild,
// and the pdf-viewer's "already mounted" WeakMap guard wrongly skips
// the rebuild).
//
// We don't actually drag here (writes content/); we simulate the morph
// outcome by stripping the per-page cards in JS, dispatching `nav`, and
// asserting the cards rebuild AND the saved comment re-mounts in the
// right page slot.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const PAGE = process.env.PAGE || "/papers/distillation"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()

phase(`load ${BASE}${PAGE}`)
await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" })
await sleep(2500)

phase("seed a comment on page 3 (skip LLM by setting state directly)")
const targetCard = page.locator(".block-card--pdf-page").nth(2)  // page 3
const blockId = await targetCard.getAttribute("data-block-id")
ok(`page-3 blockId = ${blockId}`)

await page.evaluate(({ blockId }) => {
  const w = window
  const runtime = w.__getBlockWidgetRuntimeForTest?.()
  if (!runtime) {
    // Fall back: write directly to localStorage in the same shape
    // the runtime persists. Both shapes share keying conventions.
    const state = {
      comment: "TEST seeded comment for page 3 — should survive a soft morph.",
      thread: [],
      saved: false,
      dismissedIndexes: [],
      likedIndexes: [],
      commentCreatedAt: new Date().toISOString(),
    }
    const key = `quartz:bw:ai-comment:${blockId}`
    w.localStorage.setItem(key, JSON.stringify(state))
  } else {
    runtime.set("ai-comment", blockId, {
      comment: "TEST seeded comment for page 3 — should survive a soft morph.",
      thread: [],
      saved: false,
      dismissedIndexes: [],
      likedIndexes: [],
      commentCreatedAt: new Date().toISOString(),
    })
    runtime.attachAll()
  }
}, { blockId })
// Force the runtime to re-attach via the existing event hook.
await page.evaluate(() => document.dispatchEvent(new CustomEvent("quartz:blocks-added")))
await sleep(800)

const widgetSelector = `.block-card--pdf-page[data-block-id="${blockId}"] .block-card__annotations .ai-comment-widget`
const seeded = await page.locator(widgetSelector).count()
if (seeded < 1) {
  // Use the LLM path since direct seeding didn't take.
  ok("direct seeding didn't expose runtime — falling back to ★ click")
  await targetCard.locator('button[data-block-action="jarvis-here"]').click({ force: true })
  await page.locator(widgetSelector).waitFor({ state: "attached", timeout: 90000 })
}
ok("widget mounted on page 3 before morph")

phase("simulate micromorph stripping per-page cards (the actual cause)")
const beforeStrip = await page.locator(".block-card--pdf-page").count()
await page.evaluate(() => {
  document.querySelectorAll(".block-card--pdf-page").forEach((el) => el.remove())
})
const afterStrip = await page.locator(".block-card--pdf-page").count()
if (afterStrip !== 0) fail(`expected 0 cards after strip, got ${afterStrip}`)
ok(`stripped all ${beforeStrip} per-page cards (simulating morph)`)

phase("fire nav event (what spa.inline.ts dispatches after morph)")
await page.evaluate(() => {
  document.dispatchEvent(new CustomEvent("nav", { detail: { url: location.pathname } }))
})

// pdf-viewer is async (await getDocument) so allow a few seconds.
await sleep(4500)

phase("verify per-page cards rebuilt")
const afterRebuild = await page.locator(".block-card--pdf-page").count()
if (afterRebuild !== beforeStrip) fail(`per-page cards did not rebuild: ${afterRebuild}/${beforeStrip}`)
ok(`${afterRebuild} per-page cards re-mounted`)

phase("verify the seeded comment is back on page 3")
const widgetCount = await page.locator(widgetSelector).count()
if (widgetCount !== 1) fail(`comment widget did not re-attach to page 3 (count=${widgetCount})`)
const commentText = await page.locator(`.block-card--pdf-page[data-block-id="${blockId}"] .ai-comment-widget__peers`).first().textContent()
if (!commentText || !commentText.includes("TEST seeded") && !commentText.length > 40) {
  fail(`comment text didn't survive: "${commentText?.slice(0, 200)}"`)
}
ok(`comment re-mounted on page 3: "${commentText.trim().slice(0, 100)}…"`)

await browser.close()
console.log("\nALL CHECKS PASSED")
