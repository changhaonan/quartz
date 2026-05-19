// e2e: the embedded terminal must (1) not visibly bounce between top and
// bottom while it attaches, and (2) settle pinned to the bottom.
//
// History (claude_pty/docs/terminal-typing-flicker.md + fixes):
//   - 1610abd  scrollToBottom() after terminal_replay / screen_snapshot
//   - 543b4d1  debounce fits — the iframe header's metadata-driven
//              resizes were firing a fit (reflow + re-snapshot) per tick,
//              making the terminal jump top<->bottom for ~1s on attach.
//
// Fails if the terminal bounces (a "jump to top" after it was at the
// bottom) or ends up anywhere but the bottom. Runs against the bridge.
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

// Poll fast from the moment of attach through the settle window.
const trace = []
for (let i = 0; i < 130; i++) {
  const m = await page.evaluate(() => {
    const v = document.querySelector(".xterm-viewport")
    return v ? { scrollTop: v.scrollTop, scrollH: v.scrollHeight, clientH: v.clientHeight } : null
  })
  if (m) trace.push(m)
  await sleep(40)
}

const last = trace[trace.length - 1]
if (!last) {
  fail(".xterm-viewport never appeared")
} else {
  const scrollable = last.scrollH - last.clientH
  // A "jump to top": viewport drops near the top AFTER having reached the
  // bottom — the visible bounce. Small tail-follow moves don't count.
  let reachedBottom = false
  let jumps = 0
  let prevAtTop = false
  for (const m of trace) {
    const s = m.scrollH - m.clientH
    if (s <= 60) continue // nothing to bounce within
    const atBottom = s - m.scrollTop <= 12
    const atTop = m.scrollTop <= 20
    if (atBottom) reachedBottom = true
    if (atTop && reachedBottom && !prevAtTop) jumps += 1
    prevAtTop = atTop
  }

  const offBottom = scrollable - last.scrollTop
  console.log(`  samples=${trace.length}  scrollable(final)=${scrollable}px  jumps-to-top=${jumps}`)
  console.log(`  final: scrollTop=${last.scrollTop} (${offBottom}px off bottom)`)

  if (scrollable <= 60) {
    ok("inconclusive-but-safe: terminal content fits ~one screen (no scrollback to bounce)")
  } else {
    if (jumps === 0) ok("no top<->bottom bouncing during attach")
    else fail(`terminal bounced to the top ${jumps}× during attach — the visible "闪屏"`)

    if (offBottom <= 12) ok(`settled pinned to the BOTTOM (scrollTop=${last.scrollTop}/${scrollable})`)
    else fail(`did not settle at the bottom: ${offBottom}px off`)
  }
}

await browser.close()
console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
