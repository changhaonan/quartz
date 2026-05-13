// Reproducer for "discuss failed: thread: Too big" — seed localStorage
// with a 25-turn thread for a real block on prod, push one more user
// reply, and confirm the discuss POST returns 200 (i.e. the client
// trims to .slice(-20) before sending so the bridge cap fits).
//
// Cheap: only one real LLM call (the final reply); the 25 prior turns
// are synthetic.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8080"   // prod
const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } })
const page = await ctx.newPage()
const networkErrors = []
page.on("requestfailed", (req) => networkErrors.push(`${req.method()} ${req.url()} → ${req.failure()?.errorText}`))
page.on("console", (msg) => { if (msg.type() === "error") note(`[browser error] ${msg.text()}`) })

phase("1. open homepage + confirm bundle has slice(-20) trim")
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
const bundleHasTrim = await page.evaluate(async () => {
  const r = await fetch("./postscript.js", { cache: "no-store" })
  const t = await r.text()
  return t.includes("slice(-20)")
})
if (!bundleHasTrim) fail(`prod postscript.js is missing slice(-20) — deploy didn't take`)
ok("prod bundle contains slice(-20) trim")

phase("2. wait for blocks to render; pick the first block with paragraph content")
await page.waitForSelector("article .block-card[data-block-id]", { timeout: 10000 })
await sleep(500)
const target = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll("article .block-card[data-block-id]"))
  for (const c of cards) {
    const p = c.querySelector("p[data-paragraph-hash]")
    const text = (p?.textContent || "").trim()
    if (p && text.length > 30) {
      return { blockId: c.dataset.blockId, hash: p.dataset.paragraphHash, paragraphText: text }
    }
  }
  return null
})
if (!target) fail("no suitable block with paragraph content found on /")
note(`target block: ${target.blockId} — "${target.paragraphText.slice(0, 60)}…"`)

phase("3. seed a 25-turn thread in localStorage for this block")
const seedSummary = await page.evaluate(({ blockId }) => {
  const KEY = "quartz-pty:block-widget-runtime:v2"
  const instanceKey = `ai-comment::${blockId}`
  const thread = []
  for (let i = 0; i < 12; i++) {
    thread.push({ role: "user", text: `synthetic user turn ${i + 1}`, createdAt: new Date().toISOString() })
    thread.push({ role: "ai", text: `synthetic ai reply ${i + 1}`, createdAt: new Date().toISOString() })
  }
  thread.push({ role: "user", text: "synthetic user turn 13 (last)", createdAt: new Date().toISOString() })
  const state = {
    comment: "synthetic original AI comment used as the originalComment field",
    thread,
    saved: false,
    dismissedIndexes: [],
    likedIndexes: [],
    commentCreatedAt: new Date().toISOString(),
  }
  const obj = { [instanceKey]: state }
  window.localStorage.setItem(KEY, JSON.stringify(obj))
  return { threadLen: thread.length, lastRole: thread[thread.length - 1].role }
}, { blockId: target.blockId })
note(`seeded thread length=${seedSummary.threadLen}, lastRole=${seedSummary.lastRole}`)
if (seedSummary.threadLen < 21) fail("expected 25 seeded turns")

phase("4. reload so the runtime hydrates the seeded state, then mount the widget")
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForSelector("article .block-card[data-block-id]", { timeout: 10000 })
await sleep(800)
const widgetVisible = await page.evaluate(({ blockId }) => {
  return Boolean(document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`))
}, { blockId: target.blockId })
if (!widgetVisible) fail("widget didn't rehydrate from seeded state — runtime issue")
ok("widget rehydrated from 25-turn seeded thread")

phase("5. intercept the /api/ai-comments/discuss POST and inspect payload")
const discussPosts = []
page.on("request", (req) => {
  if (req.url().includes("/api/ai-comments/discuss") && req.method() === "POST") {
    try {
      const body = JSON.parse(req.postData() || "{}")
      discussPosts.push({ url: req.url(), threadLen: Array.isArray(body.thread) ? body.thread.length : -1 })
    } catch { discussPosts.push({ url: req.url(), threadLen: -2 }) }
  }
})
const discussResponses = []
page.on("response", async (res) => {
  if (res.url().includes("/api/ai-comments/discuss") && res.request().method() === "POST") {
    let payload = null
    try { payload = await res.json() } catch {}
    discussResponses.push({ status: res.status(), payload })
  }
})

phase("6. open composer for the widget and send a reply")
await page.evaluate(({ blockId }) => {
  const widget = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)
  // Find any peer's Reply button to expand the composer; the v3 mount
  // attaches a "💬" button on each peer card.
  const replyBtn = widget?.querySelector("[data-ai-comment-action='reply']")
  if (replyBtn instanceof HTMLElement) replyBtn.click()
}, { blockId: target.blockId })
await sleep(400)
const composerOpened = await page.evaluate(({ blockId }) => {
  const widget = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)
  const form = widget?.querySelector(".ai-comment-widget__composer")
  return form && !form.hasAttribute("hidden")
}, { blockId: target.blockId })
if (!composerOpened) fail("composer didn't open after Reply click")
ok("composer open")

await page.evaluate(({ blockId }) => {
  const widget = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${blockId}"]`)
  const ta = widget?.querySelector("textarea")
  if (ta instanceof HTMLTextAreaElement) {
    ta.value = "test reply #26 — should still work post-trim"
    ta.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const sendBtn = widget?.querySelector("button[type='submit']") || widget?.querySelector("[data-ai-comment-send]")
  if (sendBtn instanceof HTMLElement) sendBtn.click()
}, { blockId: target.blockId })
note("send clicked; waiting up to 60s for discuss response")

const start = Date.now()
while (Date.now() - start < 60000) {
  if (discussResponses.length) break
  await sleep(400)
}

phase("7. assertions")
if (!discussPosts.length) fail("no /api/ai-comments/discuss POST observed")
const trimmedLen = discussPosts[0].threadLen
ok(`POST payload thread length: ${trimmedLen} (was 26 in localStorage)`)
if (trimmedLen > 20) fail(`client did NOT trim — sent ${trimmedLen} > 20`)

if (!discussResponses.length) fail("no discuss response within 60s")
const r0 = discussResponses[0]
note(`response status=${r0.status} payload=${JSON.stringify(r0.payload).slice(0, 200)}`)
if (r0.status !== 200 || !r0.payload?.ok) {
  fail(`discuss failed: status=${r0.status} error=${r0.payload?.error || "(none)"}`)
}
ok("discuss returned 200 with a reply")

await browser.close()
console.log("\n✅ Long-thread discuss against prod works (trim → bridge accepts).")
