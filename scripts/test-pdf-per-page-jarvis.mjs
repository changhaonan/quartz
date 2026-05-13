// E2E: click ★ on per-page card, wait for the LLM, verify the
// resulting comment widget lands INSIDE .block-card__annotations
// (not as a sibling-after) and the empty-state hint disappears.
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

phase(`load ${BASE}${PAGE}`)
await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" })
await sleep(2000)

phase("click ★ on per-page card #2")
const targetCard = page.locator(".block-card--pdf-page").nth(1)  // page 2
const blockId = await targetCard.getAttribute("data-block-id")
ok(`targeting per-page card data-block-id=${blockId}, data-pdf-page=${await targetCard.getAttribute("data-pdf-page")}`)

const starBtn = targetCard.locator('button[data-block-action="jarvis-here"]')
await starBtn.click({ force: true })

phase("wait for ai-comment-widget to mount inside the slot")
const widgetSelector = `.block-card--pdf-page[data-block-id="${blockId}"] .block-card__annotations .ai-comment-widget`
try {
  await page.locator(widgetSelector).waitFor({ state: "attached", timeout: 90000 })
} catch {
  fail("ai-comment-widget never mounted in annotation slot (LLM hung or wiring broken)")
}
ok("widget mounted inside .block-card__annotations slot")

phase("verify empty-state hint cleared")
const hintCount = await page.locator(`.block-card--pdf-page[data-block-id="${blockId}"] .block-card__annotations-empty`).count()
if (hintCount !== 0) fail(`empty-state hint still present after widget mount (count=${hintCount})`)
ok("empty-state hint cleared")

phase("verify the comment text exists + has substance")
const commentEl = page.locator(`.block-card--pdf-page[data-block-id="${blockId}"] .ai-comment-widget__peers`).first()
const txt = (await commentEl.textContent() || "").trim()
if (txt.length < 40) fail(`comment too short (likely failed): "${txt}"`)
if (/open .*\.pdf/i.test(txt)) fail(`comment talks about figcaption link, not paper: "${txt}"`)
ok(`comment landed: "${txt.slice(0, 200)}…"`)

await browser.close()
console.log("\nALL CHECKS PASSED")
