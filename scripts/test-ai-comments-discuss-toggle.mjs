// e2e: AI comment widgets default to ONE peer card per AI comment.
// Composer (reply input) is hidden by default; clicking 💬 (Reply) on
// any AI peer opens it. Clicking Cancel hides it again.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = "http://127.0.0.1:8090"
const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
const page = await ctx.newPage()
page.on("console", (msg) => {
  if (msg.type() === "error") note(`[browser error] ${msg.text()}`)
})

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
await page.waitForSelector(".ai-sidebar", { timeout: 8000 })
await sleep(2000)

const btn = await page.$('[data-ai-action="ai-read"]')
if (!btn) fail("AI Read button missing")
await page.evaluate((b) => b.click(), btn)
note("AI Read clicked")

const startWait = Date.now()
let widgetCount = 0
while (Date.now() - startWait < 90_000) {
  widgetCount = await page.$$eval(".ai-comment-widget", (els) => els.length)
  if (widgetCount >= 1) break
  await sleep(2000)
}
if (widgetCount < 1) fail("no widgets mounted")
ok(`${widgetCount} widgets mounted`)

// Each widget should render exactly ONE peer card on first mount (the
// original AI comment as a peer with index=-1). Composer hidden.
const initial = await page.evaluate(() => {
  const w = document.querySelector(".ai-comment-widget")
  return {
    peerCount: w?.querySelectorAll(".ai-comment-peer").length ?? -1,
    originalPeerIndex: w?.querySelector(".ai-comment-peer")?.getAttribute("data-peer-index") ?? null,
    composerOffsetHeight: w?.querySelector(".ai-comment-widget__composer")?.offsetHeight ?? -1,
  }
})
note(`first widget initial: ${JSON.stringify(initial)}`)
if (initial.peerCount !== 1) fail(`expected 1 peer on initial mount, got ${initial.peerCount}`)
if (initial.originalPeerIndex !== "-1") fail(`first peer's data-peer-index should be -1, got ${initial.originalPeerIndex}`)
if (initial.composerOffsetHeight !== 0) fail(`composer should be hidden initially, offsetHeight=${initial.composerOffsetHeight}`)
ok("default state: 1 peer (the original AI), composer hidden")

// Click Reply (💬) → composer should appear.
await page.evaluate(() => {
  const btn = document.querySelector('.ai-comment-widget [data-ai-comment-action="reply"]')
  if (btn) btn.click()
})
await sleep(300)
const afterReply = await page.evaluate(() => {
  const w = document.querySelector(".ai-comment-widget")
  return { composerOffsetHeight: w?.querySelector(".ai-comment-widget__composer")?.offsetHeight ?? -1 }
})
if (afterReply.composerOffsetHeight === 0) fail("composer should be visible after Reply clicked")
ok("Reply opens composer")

// Click Cancel → composer hides again.
await page.evaluate(() => {
  const btn = document.querySelector('.ai-comment-widget [data-ai-comment-action="cancel-reply"]')
  if (btn) btn.click()
})
await sleep(300)
const afterCancel = await page.evaluate(() => {
  const w = document.querySelector(".ai-comment-widget")
  return { composerOffsetHeight: w?.querySelector(".ai-comment-widget__composer")?.offsetHeight ?? -1 }
})
if (afterCancel.composerOffsetHeight !== 0) fail("composer should hide after Cancel")
ok("Cancel closes composer")

await browser.close()
console.log("\n✅ Peer-card default + Reply toggle test passed.")
