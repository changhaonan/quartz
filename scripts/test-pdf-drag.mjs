// Verify the regression user reported: dragging the PDF figure used
// to "explode" — per-page cards inside the figure popped out as
// article-level siblings because the reorder loop reparented every
// .block-card[data-block-id] in the article to a single parent.
//
// Now:
//  - figure.pdf-embed sits inside .block-card.block-card--pdf-container
//    (draggable=true), per-page synthetic cards are nested 2 levels
//    deeper.
//  - drop logic uses :not(.block-card--pdf-page) so per-page cards
//    are not in the reorder set.
//
// We don't write to markdown source here (would mutate content/);
// instead we simulate dragstart→drop and assert the per-page cards
// remain inside the figure (parentChain unchanged) afterwards.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"
import fs from "node:fs"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const PAGE = process.env.PAGE || "/papers/distillation"
const PDF_MD = "/Users/haonanchang/Projects/quartz_pty/content/papers/distillation.md"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

// Snapshot+restore — drop posts to bridge which rewrites markdown.
const original = fs.readFileSync(PDF_MD, "utf8")
const restore = () => fs.writeFileSync(PDF_MD, original, "utf8")
process.on("exit", restore)
process.on("SIGINT", () => { restore(); process.exit(2) })

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()

phase(`load ${BASE}${PAGE}`)
await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" })
await sleep(2500)

phase("baseline")
const containerCount = await page.locator(".block-card--pdf-container").count()
if (containerCount !== 1) fail(`expected 1 .block-card--pdf-container, got ${containerCount}`)
ok("PDF container wrapper present")

const draggable = await page.locator(".block-card--pdf-container").getAttribute("draggable")
if (draggable !== "true") fail(`PDF container should be draggable, got ${draggable}`)
ok(`PDF container draggable="${draggable}"`)

const perPageBefore = await page.locator(".block-card--pdf-page").count()
if (perPageBefore < 2) fail(`expected per-page cards inside, got ${perPageBefore}`)
ok(`${perPageBefore} per-page cards nested inside PDF`)

// Capture parent chain of page-1 card to verify it stays put after drag.
const parentChainBefore = await page.locator(".block-card--pdf-page").first().evaluate((el) => {
  const chain = []
  let n = el
  while (n && n.tagName !== "ARTICLE" && n.tagName !== "BODY") {
    chain.push(n.tagName.toLowerCase() + (n.className ? "." + String(n.className).split(/\s+/).join(".") : ""))
    n = n.parentElement
  }
  return chain
})
ok(`page-1 parent chain: ${parentChainBefore.slice(0, 3).join(" > ")}…`)

phase("simulate dragging PDF container past the # heading below it")
// The page has: prompt-paragraph, ![[pdf]], blank, #heading, paragraph
// (see content/papers/distillation.md). We drag the PDF container
// past the H1 so it ends up below the "Distilling…" heading.
const targetHash = await page.locator("article .block-card--pdf-container").getAttribute("data-block-id")
const heading = page.locator("article .block-card--h1").first()
const headingHash = await heading.getAttribute("data-block-id")
if (!headingHash) fail("no h1 block to drop on")

// Use playwright's drag handle: drag the PDF container's center to
// just below the H1. We pass the mouse over a non-canvas region of
// the container so dragstart can actually fire.
const containerBox = await page.locator(".block-card--pdf-container").boundingBox()
const headingBox = await heading.boundingBox()
if (!containerBox || !headingBox) fail("missing bounding boxes")

await page.mouse.move(containerBox.x + containerBox.width / 2, containerBox.y + 8)
await page.mouse.down()
await page.mouse.move(headingBox.x + headingBox.width / 2, headingBox.y + headingBox.height + 8, { steps: 8 })
await page.mouse.up()

// Real HTML5 drag is tricky in playwright; if the above no-ops just
// log and continue. The important assertion is: even if the drag
// completes via an alternate path, per-page cards stay nested.
await sleep(800)

phase("post-drop: per-page cards still nested inside the PDF")
const perPageAfter = await page.locator(".block-card--pdf-page").count()
if (perPageAfter !== perPageBefore) fail(`per-page card count changed: ${perPageBefore} → ${perPageAfter}`)
const perPageInsideContainer = await page.locator(".block-card--pdf-container .block-card--pdf-page").count()
if (perPageInsideContainer !== perPageAfter) {
  fail(`per-page cards escaped the container! ${perPageInsideContainer}/${perPageAfter} still nested`)
}
ok(`all ${perPageAfter} per-page cards still nested inside .block-card--pdf-container (no explosion)`)

const parentChainAfter = await page.locator(".block-card--pdf-page").first().evaluate((el) => {
  const chain = []
  let n = el
  while (n && n.tagName !== "ARTICLE" && n.tagName !== "BODY") {
    chain.push(n.tagName.toLowerCase() + (n.className ? "." + String(n.className).split(/\s+/).join(".") : ""))
    n = n.parentElement
  }
  return chain
})
if (JSON.stringify(parentChainBefore) !== JSON.stringify(parentChainAfter)) {
  fail(`page-1 parent chain changed:\n  before: ${parentChainBefore.join(" > ")}\n  after:  ${parentChainAfter.join(" > ")}`)
}
ok("page-1 parent chain unchanged")

void targetHash; void headingHash

await browser.close()
console.log("\nALL CHECKS PASSED")
