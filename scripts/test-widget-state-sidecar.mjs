// E2E: AI comments persist to content/.jarvis/widget-state.json via
// bridge sidecar, survive a localStorage wipe, and re-hydrate on
// next page load.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"
import fs from "node:fs"

const BASE = process.env.BASE || "http://127.0.0.1:8090"
const PAGE = process.env.PAGE || "/Thoughts/recent/2026-05-11"
const SIDECAR = "/Users/haonanchang/Projects/quartz_pty/content/.jarvis/widget-state.json"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

// Ensure clean baseline (snapshot + restore at end).
const hadSidecar = fs.existsSync(SIDECAR)
const snapshot = hadSidecar ? fs.readFileSync(SIDECAR, "utf8") : null
const restore = () => {
  if (snapshot != null) fs.writeFileSync(SIDECAR, snapshot, "utf8")
  else if (fs.existsSync(SIDECAR)) fs.unlinkSync(SIDECAR)
}
process.on("exit", restore)
process.on("SIGINT", () => { restore(); process.exit(2) })
if (hadSidecar) fs.writeFileSync(SIDECAR, "{}", "utf8")

const browser = await chromium.launch()
const ctx1 = await browser.newContext()
const p1 = await ctx1.newPage()

phase(`load ${BASE}${PAGE} (Tab 1, fresh state)`)
await p1.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" })
await sleep(2500)

phase("call runtime.set() directly to trigger the onMutation → POST flow")
const targetBlockId = await p1.locator("article .block-card[data-block-id]").first().getAttribute("data-block-id")
ok(`target blockId = ${targetBlockId}`)
await p1.evaluate(({ blockId }) => {
  const w = window
  if (!w.__blockWidgetRuntime) throw new Error("__blockWidgetRuntime not exposed on window")
  w.__blockWidgetRuntime.set("ai-comment", blockId, {
    comment: "SIDECAR_TEST persisted user note",
    thread: [],
    saved: false,
    dismissedIndexes: [],
    likedIndexes: [],
    commentCreatedAt: new Date().toISOString(),
  })
}, { blockId: targetBlockId })
await sleep(1500)  // debounce window is 350ms; allow for fetch round-trip

phase("verify sidecar file received the upsert")
if (!fs.existsSync(SIDECAR)) fail(`sidecar file not created: ${SIDECAR}`)
const sidecar = JSON.parse(fs.readFileSync(SIDECAR, "utf8"))
const k = `ai-comment::${targetBlockId}`
if (!sidecar[k]) fail(`expected key ${k} in sidecar, got keys: ${Object.keys(sidecar).join(", ") || "(none)"}`)
const c = sidecar[k]
if (!String(c.comment || "").includes("SIDECAR_TEST persisted user note")) {
  fail(`sidecar comment text wrong: ${JSON.stringify(c)}`)
}
ok("sidecar file contains the user's comment")

phase("Tab 2: fresh browser context (no localStorage), load same page")
const ctx2 = await browser.newContext()
const p2 = await ctx2.newPage()
await p2.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" })
await sleep(2500)

phase("verify the comment widget mounted in Tab 2 from bridge state")
// Non-PDF blocks mount the widget as a SIBLING after the block-card,
// not inside. Look at the parent's children for any adjacent widget.
const widgetCount = await p2.evaluate((blockId) => {
  const card = document.querySelector(`.block-card[data-block-id="${blockId}"]`)
  if (!card?.parentElement) return -1
  return card.parentElement.querySelectorAll(":scope > aside.ai-comment-widget").length
}, targetBlockId)
if (widgetCount < 1) fail(`expected adjacent widget in Tab 2 (state should hydrate from bridge), got ${widgetCount}`)
const widgetText = await p2.evaluate((blockId) => {
  const card = document.querySelector(`.block-card[data-block-id="${blockId}"]`)
  const aside = card?.nextElementSibling
  return aside?.textContent || ""
}, targetBlockId)
if (!widgetText.includes("SIDECAR_TEST persisted user note")) {
  fail(`Tab 2 widget didn't show the persisted text. got: "${widgetText.slice(0, 200)}"`)
}
ok("Tab 2 (no localStorage) hydrated comment from bridge sidecar")

await browser.close()
console.log("\nALL CHECKS PASSED")
