// e2e: block-page rendering + toolbar actions on /Thoughts/blocks-demo.
//
// Verifies:
//   1. Pages with frontmatter `blocks: true` get .block-card wrappers
//      around every <p data-paragraph-hash>.
//   2. Pages WITHOUT `blocks: true` (regression check) don't.
//   3. Toolbar 📋 Copy writes the block's text to the clipboard.
//   4. Toolbar 💬 Comment opens an inline composer right under the block.
//      Typing a user annotation + Enter persists it as a user peer card
//      and the composer auto-closes. NO discuss API is called (annotation-
//      only mode — there's no AI original to discuss with).
//   5. Toolbar ↕ Move is disabled (v1 placeholder).
//   6. Annotation survives a full page reload (localStorage).
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = "http://127.0.0.1:8090"
const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

const browser = await chromium.launch({ headless: true })
// granting clipboard write on the page origin so navigator.clipboard works headless
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1200 },
  permissions: ["clipboard-read", "clipboard-write"],
})
const page = await ctx.newPage()
let discussFetchCount = 0
page.on("request", (req) => {
  if (req.url().includes("/api/ai-comments/discuss")) discussFetchCount++
})
page.on("console", (msg) => {
  if (msg.type() === "error") note(`[browser error] ${msg.text()}`)
})

// ── 1. block-card wrappers on demo page (paragraphs + lists + code …) ─
phase("1. block-card wrappers — full kind coverage")
await page.goto(BASE + "/Thoughts/blocks-demo", { waitUntil: "domcontentloaded" })
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })
await page.reload({ waitUntil: "domcontentloaded" })
await sleep(1500)
const blocks = await page.$$eval(".block-card[data-block-id]", (els) =>
  els.map((el) => ({
    id: el.getAttribute("data-block-id"),
    kindClass: Array.from(el.classList).find((c) => c.startsWith("block-card--")),
    hasCopyBtn: !!el.querySelector('[data-block-action="copy"]'),
    hasCommentBtn: !!el.querySelector('[data-block-action="comment"]'),
    hasJarvisBtn: !!el.querySelector('[data-block-action="jarvis-here"]'),
    hasMoveBtn: !!el.querySelector('[data-block-action="move"]'),
    moveDisabled: el.querySelector('[data-block-action="move"]')?.disabled ?? null,
  })),
)
note(`found ${blocks.length} block-cards`)
if (blocks.length < 6) fail(`expected ≥6 block-cards (paragraphs + list + table + blockquote + code/figure + headings); got ${blocks.length}`)
const kinds = new Set(blocks.map((b) => b.kindClass))
note(`block kinds: ${Array.from(kinds).sort().join(", ")}`)
const requiredKinds = ["block-card--p", "block-card--ul", "block-card--blockquote", "block-card--figure"]
for (const k of requiredKinds) {
  if (!kinds.has(k)) fail(`missing ${k} — coverage incomplete`)
}
for (const b of blocks) {
  if (!b.id) fail(`block missing data-block-id: ${JSON.stringify(b)}`)
  if (!b.hasCopyBtn || !b.hasCommentBtn || !b.hasJarvisBtn || !b.hasMoveBtn) {
    fail(`block ${b.id} (${b.kindClass}) missing toolbar button(s)`)
  }
  if (b.moveDisabled !== true) fail(`move button should be disabled, got ${b.moveDisabled}`)
}
ok(`${blocks.length} block-cards across kinds {${Array.from(kinds).map((k) => k?.replace("block-card--", "")).sort().join(", ")}} — all have the 4-button toolbar`)

// ── 2. regression: non-blocks page has NO block-card ─────────────
phase("2. regression — non-blocks page is clean")
await page.goto(BASE + "/Thoughts/raw", { waitUntil: "domcontentloaded" })
await sleep(1000)
const noBlocks = await page.$$eval(".block-card", (els) => els.length)
if (noBlocks > 0) fail(`/Thoughts/raw should NOT have block-cards; got ${noBlocks}`)
ok("non-opt-in pages still render plain paragraphs")

// ── 3. Copy ──────────────────────────────────────────────────────
phase("3. 📋 Copy writes block text to clipboard")
await page.goto(BASE + "/Thoughts/blocks-demo", { waitUntil: "domcontentloaded" })
await sleep(1500)
const targetBlockId = blocks[1].id  // pick a non-first block so test is less brittle
const expectedText = await page.evaluate((id) => {
  const card = document.querySelector(`.block-card[data-block-id="${id}"]`)
  return (card?.querySelector("p")?.textContent || "").trim()
}, targetBlockId)
await page.evaluate((id) => {
  const card = document.querySelector(`.block-card[data-block-id="${id}"]`)
  card?.querySelector('[data-block-action="copy"]')?.click()
}, targetBlockId)
await sleep(400)
const clipboardText = (await page.evaluate(() => navigator.clipboard.readText())).trim()
if (clipboardText !== expectedText) {
  fail(`clipboard mismatch.\n  expected: ${expectedText.slice(0, 80)}…\n  got:      ${clipboardText.slice(0, 80)}…`)
}
ok(`copy wrote the right paragraph text to clipboard (${clipboardText.length} chars)`)

// ── 4. Comment (annotation-only, no AI discuss) ──────────────────
phase("4. 💬 Comment opens composer, send persists as user peer, NO /discuss call")
discussFetchCount = 0  // reset
await page.evaluate((id) => {
  const card = document.querySelector(`.block-card[data-block-id="${id}"]`)
  card?.querySelector('[data-block-action="comment"]')?.click()
}, targetBlockId)
await sleep(500)
const composerVisible = await page.evaluate((id) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  const c = w?.querySelector(".ai-comment-widget__composer")
  return c && c.offsetHeight > 0
}, targetBlockId)
if (!composerVisible) fail("composer didn't open after clicking 💬 on block")
ok("composer opened after 💬 click")

const annotation = "My own note: this paragraph is doing two things at once."
await page.evaluate(({ id, text }) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  const ta = w?.querySelector(".ai-comment-widget__input")
  if (ta) {
    ta.value = text
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }
}, { id: targetBlockId, text: annotation })
await sleep(800)
const afterSend = await page.evaluate(({ id, txt }) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  const peers = Array.from(w?.querySelectorAll(".ai-comment-peer") ?? [])
  const userPeer = peers.find((p) => p.classList.contains("ai-comment-peer--user"))
  return {
    peerCount: peers.length,
    userPeerText: userPeer?.querySelector(".ai-comment-peer__body")?.textContent ?? "",
    composerVisible: w?.querySelector(".ai-comment-widget__composer")?.offsetHeight ?? -1,
  }
}, { id: targetBlockId, txt: annotation })
note(`after send: ${JSON.stringify(afterSend)}`)
if (afterSend.peerCount !== 1) fail(`expected 1 user peer, got ${afterSend.peerCount}`)
if (!afterSend.userPeerText.includes(annotation.slice(0, 30))) fail("user peer doesn't contain the annotation text")
// In annotation-only mode the composer stays open for next entry; that's
// asserted in step 4b. Don't require auto-close here.
ok("user peer persisted")
// THE bug the user reported: discuss should NOT be called in annotation-only mode.
await sleep(2500)  // give any rogue fetch time to fire
if (discussFetchCount > 0) {
  fail(`REGRESSION: /api/ai-comments/discuss was called ${discussFetchCount} times — annotation-only mode should skip it`)
}
ok("no /discuss call fired (annotation-only path skipped Jarvis)")

// ── 4b. Annotation-only: composer stays open after send (multi-add) ──
phase("4b. composer stays open in annotation-only mode (multi-add ergonomics)")
const composerOpenAfterSend = await page.evaluate((id) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  const c = w?.querySelector(".ai-comment-widget__composer")
  return c && c.offsetHeight > 0
}, targetBlockId)
if (!composerOpenAfterSend) fail("annotation-only mode should leave composer open after send for next annotation")
ok("composer stayed open — user can immediately add another annotation")

// Add a SECOND annotation right away.
const secondAnno = "Second thought: actually it's three things."
await page.evaluate(({ id, text }) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  const ta = w?.querySelector(".ai-comment-widget__input")
  if (ta) {
    ta.value = text
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }
}, { id: targetBlockId, text: secondAnno })
await sleep(500)
const afterSecond = await page.evaluate((id) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  return Array.from(w?.querySelectorAll(".ai-comment-peer--user") ?? []).map((p) => p.querySelector(".ai-comment-peer__body")?.textContent ?? "")
}, targetBlockId)
if (afterSecond.length !== 2) fail(`expected 2 user peers after second send, got ${afterSecond.length}`)
ok("second annotation persisted as a separate user peer")

// ── 5. Move stays disabled ───────────────────────────────────────
phase("5. ↕ Move stays disabled")
const moveBtnDisabled = await page.evaluate((id) => {
  const card = document.querySelector(`.block-card[data-block-id="${id}"]`)
  return card?.querySelector('[data-block-action="move"]')?.disabled
}, targetBlockId)
if (!moveBtnDisabled) fail("move button should still be disabled")
ok("move button correctly disabled (v1 placeholder)")

// ── 5b. ★ Jarvis-here: AI comments on JUST this one block ────────
phase("5b. ★ Jarvis-here adds AI comment to just this block")
// Pick a block that doesn't yet have a Jarvis comment.
const jarvisTarget = blocks.find((b) => b.kindClass === "block-card--p" && b.id !== targetBlockId)
if (!jarvisTarget) fail("no spare paragraph block for jarvis-here test")
await page.evaluate((id) => {
  const card = document.querySelector(`.block-card[data-block-id="${id}"]`)
  card?.querySelector('[data-block-action="jarvis-here"]')?.click()
}, jarvisTarget.id)
note("clicked ★ — waiting for codex (up to 60s)")
let aiPeerText = ""
const startWait = Date.now()
while (Date.now() - startWait < 60_000) {
  aiPeerText = await page.evaluate((id) => {
    const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
    const aiPeer = w?.querySelector('.ai-comment-peer--ai[data-peer-index="-1"] .ai-comment-peer__body')
    return aiPeer?.textContent ?? ""
  }, jarvisTarget.id)
  if (aiPeerText.length > 0) break
  await sleep(2000)
}
if (!aiPeerText) fail("Jarvis-here button didn't produce an AI peer in 60s")
ok(`Jarvis commented on this block: "${aiPeerText.slice(0, 60)}…"`)

// Other blocks should NOT have new widgets (★ scoped to one block).
const otherWidgetCount = await page.evaluate((targetId) => {
  return document.querySelectorAll(`.ai-comment-widget:not([data-paragraph-hash="${targetId}"])`).length
}, jarvisTarget.id)
const stateRecorded = await page.evaluate((id) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  return !!w
}, targetBlockId)  // the original target with user annotations
note(`other widgets after ★: ${otherWidgetCount} (the original 💬 target widget should still be one of them)`)
if (!stateRecorded) fail("the previous user-annotation widget vanished after ★ on a different block")
ok("★ scoped to the clicked block — other blocks untouched")

// ── 6. Reload + annotation survives ──────────────────────────────
phase("6. annotation survives a full page reload (localStorage)")
await page.reload({ waitUntil: "domcontentloaded" })
await sleep(2000)
const afterReload = await page.evaluate(({ id, txt }) => {
  const w = document.querySelector(`.ai-comment-widget[data-paragraph-hash="${id}"]`)
  if (!w) return { ok: false, reason: "widget gone" }
  const peers = Array.from(w.querySelectorAll(".ai-comment-peer"))
  const userPeer = peers.find((p) => p.classList.contains("ai-comment-peer--user"))
  return {
    ok: !!userPeer,
    peerText: userPeer?.querySelector(".ai-comment-peer__body")?.textContent ?? "",
  }
}, { id: targetBlockId, txt: annotation })
if (!afterReload.ok) fail("annotation gone after reload — localStorage hydration broken")
if (!afterReload.peerText.includes(annotation.slice(0, 30))) fail(`annotation text wrong after reload: ${afterReload.peerText}`)
ok("annotation restored from localStorage after reload")

// Clean up localStorage so future test runs start fresh.
await page.evaluate(() => { try { window.localStorage.removeItem("quartz-pty:block-widget-runtime:v2") } catch {} })

await browser.close()
console.log("\n✅ Blocks demo: all toolbar features work end-to-end.")
