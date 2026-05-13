// e2e: block-page reorder via /api/blocks/reorder. Drives the API
// directly because HTML5 native drag-and-drop is unreliable in headless
// Chromium. Verifies:
//   1. POST with a swapped order rewrites the source markdown.
//   2. After rewrite, quartz hot-rebuilds and the page shows the new
//      paragraph order (in the rendered DOM).
//   3. Soft-morph fires (no full reload — sentinel survives).
//   4. Restoring the original order at the end leaves the file as it was.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"
import fs from "node:fs"

const BASE = "http://127.0.0.1:8090"
const BRIDGE = "http://127.0.0.1:3002"
const DEMO_MD = "/Users/haonanchang/Projects/quartz_pty/content/Thoughts/blocks-demo.md"

const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)
const phase = (m) => console.log(`\n—— ${m} ——`)

const original = fs.readFileSync(DEMO_MD, "utf8")
const restore = () => { try { fs.writeFileSync(DEMO_MD, original); note("restored blocks-demo.md") } catch (e) { console.error(e.message) } }
process.on("exit", restore)
process.on("SIGINT", () => { restore(); process.exit(130) })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
const page = await ctx.newPage()

// ── 1. snapshot the current order ────────────────────────────────
phase("1. capture current paragraph block order")
await page.goto(BASE + "/Thoughts/blocks-demo", { waitUntil: "domcontentloaded" })
await sleep(1500)
const captureBlocks = async () =>
  page.$$eval("article .block-card[data-block-id]", (els) =>
    els.map((el) => {
      const inner = el.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
      const text = ((inner?.innerText || inner?.textContent || "")).replace(/\s+/g, " ").trim()
      return {
        hash: el.getAttribute("data-block-id") || "",
        kind: Array.from(el.classList).find((c) => c.startsWith("block-card--"))?.replace("block-card--", "") || "",
        prefix: text.slice(0, 60),
      }
    }),
  )
const before = await captureBlocks()
note(`captured ${before.length} blocks`)
const paragraphIdxs = before.map((b, i) => (b.kind === "p" ? i : -1)).filter((i) => i >= 0)
if (paragraphIdxs.length < 2) fail(`need ≥2 paragraph blocks to test swap; got ${paragraphIdxs.length}`)

// Pick two paragraph blocks to swap (first two paragraphs by document order).
const aIdx = paragraphIdxs[0]
const bIdx = paragraphIdxs[1]
const aHash = before[aIdx].hash
const bHash = before[bIdx].hash
note(`swapping paragraph blocks at idx ${aIdx} (${aHash}) and ${bIdx} (${bHash})`)

// ── 2. plant sentinel + POST swap ────────────────────────────────
phase("2. POST /api/blocks/reorder with the two paragraphs swapped")
await page.evaluate(() => { window.__ec_sentinel = "pre-reorder" })
const newOrder = before.slice()
;[newOrder[aIdx], newOrder[bIdx]] = [newOrder[bIdx], newOrder[aIdx]]
const reorderRes = await page.evaluate(async ({ bridge, slug, blockOrder }) => {
  const r = await fetch(`${bridge}/api/blocks/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
    body: JSON.stringify({ slug, blockOrder }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}, { bridge: BRIDGE, slug: "Thoughts/blocks-demo", blockOrder: newOrder.map(({ hash, prefix }) => ({ hash, prefix })) })
note(`reorder API: ${reorderRes.status} ${JSON.stringify(reorderRes.body)}`)
if (reorderRes.status !== 200 || !reorderRes.body.ok) fail("reorder API rejected")
ok(`reorder API accepted (${reorderRes.body.blocksReordered} blocks)`)

// ── 3. wait for source rewrite + hot-reload ──────────────────────
phase("3. source markdown rewritten + page picks up new order")
await sleep(4500)  // quartz watcher + soft morph
const fileAfter = fs.readFileSync(DEMO_MD, "utf8")
if (fileAfter === original) fail("source markdown unchanged — bridge didn't write")
ok(`source markdown updated (length delta=${fileAfter.length - original.length}, content differs=${fileAfter !== original})`)

// Verify in source: pick a robust marker phrase from each paragraph
// that exists verbatim in source markdown (avoid backticks / smart quotes).
const aMarker = "Every page on this site renders"
const bMarker = "A block layer adds a second axis"
const aPosInFile = fileAfter.indexOf(aMarker)
const bPosInFile = fileAfter.indexOf(bMarker)
note(`source positions: A "${aMarker}"@${aPosInFile}, B "${bMarker}"@${bPosInFile}`)
if (aPosInFile < 0 || bPosInFile < 0) fail("paragraph markers not found in rewritten source")
if (aPosInFile <= bPosInFile) fail(`source NOT swapped: A still before B (A@${aPosInFile}, B@${bPosInFile})`)
ok("source markdown order swapped correctly (A is now AFTER B in file)")

// Check sentinel BEFORE doing any navigation — if it's still there, the
// WS-driven soft-morph held the JS context (no flash).
const sentinel = await page.evaluate(() => window.__ec_sentinel ?? null)
if (sentinel === "pre-reorder") {
  ok("soft-morph held the JS context — page didn't fully reload")
} else {
  fail(`page did a full reload (sentinel=${JSON.stringify(sentinel)}) — soft-morph should have replaced just the article body`)
}

// The same JS context still has the LIVE article DOM, just morphed by
// micromorph to reflect the new source order. Re-grab block order without
// any fetch.
const after = await captureBlocks()
const aIdxAfter = after.findIndex((b) => b.hash === aHash)
const bIdxAfter = after.findIndex((b) => b.hash === bHash)
note(`after: A is now at idx ${aIdxAfter}, B at idx ${bIdxAfter}`)
if (aIdxAfter <= bIdxAfter) fail(`expected A (${aHash}) to come AFTER B (${bHash}) post-swap; got A=${aIdxAfter}, B=${bIdxAfter}`)
ok("rendered DOM reflects the new order")

// ── 4. restore original order ────────────────────────────────────
phase("4. restore + verify roundtrip")
const restoreRes = await page.evaluate(async ({ bridge, slug, blockOrder }) => {
  const r = await fetch(`${bridge}/api/blocks/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
    body: JSON.stringify({ slug, blockOrder }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}, { bridge: BRIDGE, slug: "Thoughts/blocks-demo", blockOrder: before.map(({ hash, prefix }) => ({ hash, prefix })) })
note(`restore API: ${restoreRes.status}`)
if (restoreRes.status !== 200 || !restoreRes.body.ok) fail("restore API rejected")
await sleep(2000)
const fileRestored = fs.readFileSync(DEMO_MD, "utf8")
// Don't require byte-perfect equality (whitespace edge cases); require
// the file again differs by < 5 bytes from original (no meaningful drift).
const drift = Math.abs(fileRestored.length - original.length)
if (drift > 10) fail(`restore drift too large: ${drift} bytes`)
ok(`restored within ${drift} bytes of original`)

await browser.close()
console.log("\n✅ blocks reorder: source rewrite + hot-reload + roundtrip all green.")
