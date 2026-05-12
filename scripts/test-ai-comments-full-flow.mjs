// e2e: v3 AI-comments full flow (no Keep, no markdown write-back).
//
// Verifies the simplified design:
//   - AI Read mounts widgets, each with one peer card (original AI).
//   - Click 💬 Reply → composer appears.
//   - Type + Enter → user peer + AI reply peer appear.
//   - Composer auto-closes after the AI reply arrives.
//   - Each AI peer has ONLY ✗ dismiss + 💬 reply (no ▲ Keep button).
//   - Click ✗ on a non-original AI peer → that peer hides; widget alive.
//   - Click ✗ on original AI peer → whole widget retires.
//   - State persists across full page reload (localStorage, not session).
//
// No markdown file should be modified at any point.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"
import fs from "node:fs"
import path from "node:path"

const BASE = "http://127.0.0.1:8090"
const INDEX_MD = "/Users/haonanchang/Projects/quartz_pty/content/index.md"
const SHOTS_DIR = "/Users/haonanchang/Projects/quartz_pty/scripts/.test-output/ai-comments-flow"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

fs.mkdirSync(SHOTS_DIR, { recursive: true })
const originalMd = fs.readFileSync(INDEX_MD, "utf8")

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } })
const page = await ctx.newPage()
page.on("console", (msg) => {
  if (msg.type() === "error") note(`[browser error] ${msg.text()}`)
})
const shot = async (name) => {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true })
  note(`  screenshot → ${name}.png`)
}

// ── A. AI Read → 1 peer per widget ────────────────────────────────
phase("A. Page load + AI Read")
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
// One-time clear of prior-run state. Done AFTER first load (not via
// addInitScript, which fires on every navigation and would wipe state
// during the reload phase below).
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForSelector(".ai-sidebar", { timeout: 8000 })
await sleep(2000)
await shot("01-loaded")

await page.evaluate(() => document.querySelector('[data-ai-action="ai-read"]')?.click())
note("AI Read clicked")

let hashes = []
const startWait = Date.now()
while (Date.now() - startWait < 90_000) {
  hashes = await page.$$eval(".ai-comment-widget", (els) => els.map((e) => e.getAttribute("data-paragraph-hash")))
  if (hashes.length >= 2) break
  await sleep(2000)
}
if (hashes.length < 2) fail(`only ${hashes.length} widgets`)
ok(`${hashes.length} widgets mounted`)
await shot("02-after-ai-read")

const targetHash = hashes[0]

// Buttons on the AI peer: only dismiss + reply (no keep).
const initialButtons = await page.evaluate((h) => {
  const peer = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-peer[data-peer-index="-1"]`)
  return Array.from(peer?.querySelectorAll("[data-ai-comment-action]") ?? []).map((b) => b.getAttribute("data-ai-comment-action"))
}, targetHash)
note(`AI peer action buttons: ${JSON.stringify(initialButtons)}`)
if (initialButtons.includes("keep")) fail(`v3 should NOT have a 'keep' button; saw ${JSON.stringify(initialButtons)}`)
if (!initialButtons.includes("dismiss") || !initialButtons.includes("reply")) {
  fail(`AI peer should have dismiss + reply; got ${JSON.stringify(initialButtons)}`)
}
ok("AI peer has exactly dismiss + reply (no keep)")

// ── B. Reply flow + composer auto-close ───────────────────────────
phase("B. Reply round-trip; composer auto-closes after AI reply")
await page.evaluate((h) => {
  document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] [data-ai-comment-action="reply"]`)?.click()
}, targetHash)
await sleep(300)
const composerOpenH = await page.evaluate((h) => document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-widget__composer`)?.offsetHeight ?? -1, targetHash)
if (composerOpenH <= 0) fail(`composer didn't open; height=${composerOpenH}`)
ok("composer opened")
await shot("03-composer-open")

const userQ = "Sharpen this: what would falsify the claim?"
await page.evaluate(({ h, q }) => {
  const ta = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-widget__input`)
  if (ta) {
    ta.value = q
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }
}, { h: targetHash, q: userQ })
note(`sent: "${userQ}"`)

// Composer must close IMMEDIATELY on send — before the AI even replies.
// Poll up to 1s; should snap to hidden within a frame or two.
let composerClosedSoon = false
const closePollStart = Date.now()
while (Date.now() - closePollStart < 1500) {
  const h = await page.evaluate((h) => {
    const c = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-widget__composer`)
    return { hidden: c?.hasAttribute("hidden") ?? null, offsetHeight: c?.offsetHeight ?? -1 }
  }, targetHash)
  if (h.hidden === true && h.offsetHeight === 0) { composerClosedSoon = true; break }
  await sleep(100)
}
if (!composerClosedSoon) fail("REGRESSION: composer did not close within 1.5s of send — should close synchronously on send, not after AI reply")
ok("composer closed synchronously on send (before AI reply)")

// Now wait for the AI reply to land as a third peer.
let peerCount = 0
const replyStart = Date.now()
while (Date.now() - replyStart < 90_000) {
  peerCount = await page.evaluate((h) => document.querySelectorAll(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-peer`).length, targetHash)
  if (peerCount >= 3) break
  await sleep(2000)
}
if (peerCount < 3) fail(`expected 3 peers after AI reply; got ${peerCount}`)
ok(`AI replied → ${peerCount} peers`)
await shot("04-after-reply")

// ── C. No markdown write happened ─────────────────────────────────
phase("C. Source markdown unchanged (v3 doesn't write to disk)")
const fileNow = fs.readFileSync(INDEX_MD, "utf8")
if (fileNow !== originalMd) {
  // Restore so we don't pollute, then fail.
  fs.writeFileSync(INDEX_MD, originalMd)
  fail(`v3 should not modify markdown; file grew by ${fileNow.length - originalMd.length} bytes`)
}
ok("index.md untouched")

// ── D. Dismiss flow ───────────────────────────────────────────────
phase("D. ✗ Dismiss on non-original peer hides it; widget alive")
const aiReplyIndex = await page.evaluate((h) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"]`)
  const peers = Array.from(w?.querySelectorAll(".ai-comment-peer") ?? [])
  const aiReply = peers.reverse().find((p) => p.classList.contains("ai-comment-peer--ai") && p.getAttribute("data-peer-index") !== "-1")
  return aiReply?.getAttribute("data-peer-index") ?? null
}, targetHash)
if (aiReplyIndex === null) fail("couldn't find AI reply peer")

await page.evaluate(({ h, idx }) => {
  document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-peer[data-peer-index="${idx}"] [data-ai-comment-action="dismiss"]`)?.click()
}, { h: targetHash, idx: aiReplyIndex })
await sleep(400)
const afterDismiss = await page.evaluate(({ h, idx }) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"]`)
  return {
    widgetAlive: !!w,
    peerStillThere: !!w?.querySelector(`.ai-comment-peer[data-peer-index="${idx}"]`),
    remainingPeers: w?.querySelectorAll(".ai-comment-peer").length ?? 0,
  }
}, { h: targetHash, idx: aiReplyIndex })
if (!afterDismiss.widgetAlive) fail("dismissing a non-original peer killed the whole widget")
if (afterDismiss.peerStillThere) fail("dismissed peer is still visible")
ok(`dismissed peer ${aiReplyIndex} hidden; widget alive (${afterDismiss.remainingPeers} peers remaining)`)
await shot("05-after-dismiss-peer")

// ── E. Persistence across full reload (localStorage) ──────────────
phase("E. Reload page; widget + thread re-mount from localStorage")
await page.reload({ waitUntil: "domcontentloaded" })
await sleep(2500)
const afterReload = await page.evaluate((h) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"]`)
  return {
    widgetAlive: !!w,
    peers: Array.from(w?.querySelectorAll(".ai-comment-peer") ?? []).map((p) => ({
      idx: p.getAttribute("data-peer-index"),
      role: p.classList.contains("ai-comment-peer--ai") ? "ai" : "user",
      text: p.querySelector(".ai-comment-peer__body")?.textContent?.slice(0, 40),
    })),
  }
}, targetHash)
note(`after full reload: ${JSON.stringify(afterReload, null, 2)}`)
if (!afterReload.widgetAlive) fail("widget gone after reload — localStorage hydration broken")
if (afterReload.peers.length < 2) fail(`expected 2+ peers after reload (orig AI + user); got ${afterReload.peers.length}`)
ok(`widget rehydrated from localStorage (${afterReload.peers.length} peers visible)`)
await shot("06-after-reload")

// ── F. Dismiss original AI → whole widget retires ─────────────────
phase("F. ✗ on original AI peer retires the entire widget")
await page.evaluate((h) => {
  document.querySelector(`.ai-comment-widget[data-paragraph-hash="${h}"] .ai-comment-peer[data-peer-index="-1"] [data-ai-comment-action="dismiss"]`)?.click()
}, targetHash)
await sleep(400)
const stillThere = await page.$(`.ai-comment-widget[data-paragraph-hash="${targetHash}"]`)
if (stillThere) fail("dismissing original peer did not retire the widget")
ok("widget retired when original peer dismissed")
await shot("07-after-dismiss-original")

// ── G. Re-running Jarvis Read is additive (no duplicate re-comment) ──
phase("G. Second Jarvis Read preserves existing comments")
// Re-mount surviving widgets first by reloading (we just dismissed the
// original peer above; freshly load to get a clean baseline).
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })
await page.reload({ waitUntil: "domcontentloaded" })
await sleep(2000)
// First Jarvis Read.
await page.evaluate(() => document.querySelector('[data-ai-action="ai-read"]')?.click())
let firstHashes = []
const firstStart = Date.now()
while (Date.now() - firstStart < 90_000) {
  firstHashes = await page.$$eval(".ai-comment-widget", (els) => els.map((e) => e.getAttribute("data-paragraph-hash")))
  if (firstHashes.length >= 1) break
  await sleep(2000)
}
if (firstHashes.length < 1) fail("first Jarvis Read mounted nothing")
ok(`first Jarvis Read: ${firstHashes.length} widgets mounted`)

// Second Jarvis Read — should NOT increase widget count (all paragraphs
// are already commented).
await page.evaluate(() => document.querySelector('[data-ai-action="ai-read"]')?.click())
await sleep(3000)  // generate is faster when nothing to send
const statusAfterSecond = await page.evaluate(() => document.querySelector("[data-ai-status]")?.textContent ?? "")
const secondHashes = await page.$$eval(".ai-comment-widget", (els) => els.map((e) => e.getAttribute("data-paragraph-hash")))
note(`status after 2nd read: "${statusAfterSecond}"`)
note(`widgets after 2nd read: ${secondHashes.length}`)
if (secondHashes.length !== firstHashes.length) {
  fail(`second Jarvis Read changed widget count from ${firstHashes.length} to ${secondHashes.length} — should be additive`)
}
if (!statusAfterSecond.toLowerCase().includes("already") && !statusAfterSecond.toLowerCase().includes("preserved")) {
  fail(`second Jarvis Read status should mention "already commented"; got: "${statusAfterSecond}"`)
}
ok("second Jarvis Read preserved existing comments (additive, not full replace)")

// Clean up localStorage to leave the browser in a clean state for next runs.
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })

await browser.close()
console.log("\n✅ v3 full flow passed: localStorage-backed, dismiss-only, composer auto-closes.")
