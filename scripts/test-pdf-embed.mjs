// e2e: verify a PDF embed page renders, the iframe loads the actual
// PDF, the block-card hover toolbar is wired, and clicking 💬 on the
// PDF block seeds a margin-comment widget that survives a reload.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const PAGE = "/papers/distillation"
const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
const page = await ctx.newPage()
page.on("console", (msg) => { if (msg.type() === "error") note(`[browser error] ${msg.text()}`) })

phase("1. open page + assert PDF iframe is wired")
await page.goto(BASE + PAGE, { waitUntil: "domcontentloaded" })
await page.waitForSelector(".pdf-embed iframe.pdf", { timeout: 8000 })

const iframeSrc = await page.locator(".pdf-embed iframe.pdf").first().getAttribute("src")
if (!iframeSrc || !iframeSrc.endsWith("distillation.pdf")) {
  fail(`iframe src wrong: ${iframeSrc}`)
}
ok(`iframe src: ${iframeSrc}`)

phase("2. block-card wraps the PDF figure with a stable hash id")
const blockCardInfo = await page.evaluate(() => {
  const figure = document.querySelector(".pdf-embed")
  if (!figure) return { error: "no figure" }
  const card = figure.closest(".block-card")
  if (!card) return { error: "figure not inside block-card" }
  return {
    blockId: card.getAttribute("data-block-id") || "",
    cardKind: card.className,
    cardHasId: !!card.id,
  }
})
if (blockCardInfo.error) fail(blockCardInfo.error)
if (!blockCardInfo.blockId || blockCardInfo.blockId.length !== 12) {
  fail(`block-id missing or malformed: ${JSON.stringify(blockCardInfo)}`)
}
ok(`PDF block-card data-block-id = ${blockCardInfo.blockId}`)

phase("3. PDF actually loads (HEAD request, 200 + non-zero size)")
const pdfProbe = await page.evaluate(async (src) => {
  const r = await fetch(src, { method: "HEAD" })
  return { status: r.status, len: r.headers.get("content-length") }
}, iframeSrc)
note(`HEAD ${iframeSrc}: ${JSON.stringify(pdfProbe)}`)
if (pdfProbe.status !== 200) fail(`PDF returned ${pdfProbe.status}`)
if (!pdfProbe.len || Number(pdfProbe.len) < 10000) fail(`PDF content-length suspicious: ${pdfProbe.len}`)
ok(`PDF served, ${(Number(pdfProbe.len) / 1024).toFixed(0)} KB`)

phase("4. click 💬 on the PDF block → margin-comment widget appears")
// Hover the PDF block-card so its toolbar shows, then click the comment
// button. Use force-click on the data-block-action selector to bypass
// hover visibility (the button is opacity-0 until hover, but it IS in
// the DOM and clickable).
const pdfBlockSel = `.block-card[data-block-id="${blockCardInfo.blockId}"]`
await page.locator(pdfBlockSel).hover()
await sleep(200)
await page.locator(`${pdfBlockSel} button[data-block-action="comment"]`).click({ force: true })
await sleep(500)

const widgetVisible = await page.evaluate((blockId) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)
  return Boolean(w)
}, blockCardInfo.blockId)
if (!widgetVisible) fail("margin-comment widget didn't mount after 💬 click")
ok("margin-comment widget mounted on the PDF block")

phase("5. type an annotation, send → widget keeps the user peer-card")
const composerSel = `.ai-comment-widget[data-paragraph-hash="${blockCardInfo.blockId}"] textarea.ai-comment-widget__input`
await page.locator(composerSel).fill("Skim § 3 first — the temperature softening trick is the heart of it.")
await page.locator(`.ai-comment-widget[data-paragraph-hash="${blockCardInfo.blockId}"] form.ai-comment-widget__composer button[type=submit]`).click()
await sleep(500)

const peerCount = await page.evaluate((blockId) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)
  return w ? w.querySelectorAll(".ai-comment-peer").length : 0
}, blockCardInfo.blockId)
note(`peer count after send: ${peerCount}`)
if (peerCount < 1) fail("user annotation didn't render as a peer card")
ok(`annotation persisted as peer card (${peerCount} peers)`)

phase("6. reload page → annotation rehydrates from localStorage")
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForSelector(".pdf-embed iframe.pdf", { timeout: 8000 })
await sleep(800)
const peerCountAfter = await page.evaluate((blockId) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)
  return w ? w.querySelectorAll(".ai-comment-peer").length : 0
}, blockCardInfo.blockId)
if (peerCountAfter < 1) fail(`annotation lost across reload (was ${peerCount}, now ${peerCountAfter})`)
ok(`annotation rehydrated across reload (${peerCountAfter} peers)`)

// Cleanup: clear localStorage so subsequent runs start fresh.
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })

await browser.close()
console.log("\n✅ PDF embed: served, block-card-wrapped, commentable, persistent.")
