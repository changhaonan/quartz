// e2e: the embedded terminal must land at the BOTTOM on first attach,
// after the bridge replays scrollback — not stuck at the top.
//
// History (claude_pty/docs/terminal-typing-flicker.md):
//   - 1610abd: scrollToBottom() after terminal_replay / screen_snapshot.
//   - ca731ce: re-pin to bottom after fit() — the settle-timer /
//     ResizeObserver fire a fit() right after the replay, and the
//     reflow was shoving the viewport back to the top on first load.
//
// This test fails if EITHER regresses. Runs against the staging bridge.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BRIDGE = process.env.BRIDGE || "http://127.0.0.1:3001"
const fail = (m) => {
  console.error("X", m)
  process.exitCode = 1
}
const ok = (m) => console.log("✓", m)

const sessions = await fetch(`${BRIDGE}/api/sessions`)
  .then((r) => r.json())
  .then((j) => j.sessions || j)
// a session with a populated TUI gives us real scrollback to mis-place
const target = sessions.find((s) => s.state === "waiting_input") || sessions[0]
const sessionId = target?.sessionId || target?.id
if (!sessionId) {
  fail("no session available on the bridge to probe")
  process.exit(1)
}
console.log(`probing session ${sessionId} (${target.state})`)

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
await page.goto(`${BRIDGE}/bridge/session?session=${encodeURIComponent(sessionId)}`, {
  waitUntil: "domcontentloaded",
})
await page.waitForSelector(".xterm-viewport", { timeout: 8000 })

const sample = () =>
  page.evaluate(() => {
    const v = document.querySelector(".xterm-viewport")
    return v ? { scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight } : null
  })

// Sample across the whole first-attach settle window: replay lands, then
// the settle-timer + ResizeObserver fire fits. The viewport must be at the
// bottom by the time it settles — and must not be left at the top.
let m = null
let everStuckAtTop = false
let elapsed = 0
for (const t of [1000, 2000, 3500, 5000, 7000]) {
  await sleep(t - elapsed)
  elapsed = t
  m = await sample()
  const scrollable = m ? m.scrollHeight - m.clientHeight : 0
  const offBottom = m ? scrollable - m.scrollTop : 0
  const tag =
    scrollable <= 4 ? "(fits one screen)" : offBottom <= 8 ? "BOTTOM" : m.scrollTop === 0 ? "TOP" : `${offBottom}px off`
  console.log(`  t=${t}ms`, JSON.stringify(m), tag)
  if (scrollable > 4 && m.scrollTop === 0) everStuckAtTop = true
}

if (!m) {
  fail(".xterm-viewport never appeared")
} else {
  const scrollable = m.scrollHeight - m.clientHeight
  const offBottom = scrollable - m.scrollTop
  if (scrollable <= 4) {
    ok("inconclusive-but-safe: terminal content fits one screen (no scrollback to mis-place)")
  } else if (offBottom <= 8) {
    ok(`first attach settled at the BOTTOM (scrollTop=${m.scrollTop}/${scrollable}, ${offBottom}px off)`)
    if (everStuckAtTop) console.log("  note: was briefly at top mid-settle, then corrected — acceptable")
  } else if (m.scrollTop === 0) {
    fail(`terminal stuck at the TOP after first attach — the reported bug (scrollable=${scrollable}px)`)
  } else {
    fail(`terminal not at bottom after first attach: ${offBottom}px off (scrollable=${scrollable})`)
  }
}

await browser.close()
console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
