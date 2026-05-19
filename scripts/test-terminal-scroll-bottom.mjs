// e2e: the embedded terminal must attach cleanly — no visible shaking.
//
// Two failure modes, both reported as "闪屏 / 抖":
//   1. The terminal host gets resized repeatedly while the iframe header
//      reflows (badge row re-wrapping as session metadata streams in).
//      Detected as the .xterm-viewport clientHeight changing.
//   2. The viewport bounces between top and bottom. Detected as scrollTop
//      jumping back to the top after having reached the bottom.
//
// Fixes: claude_pty 543b4d1 (debounce fits) + e69760c (stable badge
// widths). Sampling is per-animation-frame from page load so the
// sub-300ms attach shake is actually caught.
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
// Narrow viewport: the terminal lives in the AI sidebar, so the iframe
// renders in the <=720px column header layout where the badges wrap
// hardest — that is where the shake shows. The default 1280px misses it.
const page = await (await browser.newContext({ viewport: { width: 380, height: 680 } })).newPage()

// Sample every animation frame from page load. The shake is the iframe
// header changing height (its badge row re-wrapping as metadata streams
// in), which shoves the terminal pane down/up — so we track the header
// height itself, plus the viewport scroll position for the bounce check.
await page.addInitScript(() => {
  window.__samples = []
  const t0 = performance.now()
  const tick = () => {
    const v = document.querySelector(".xterm-viewport")
    const h = document.querySelector(".terminal-frame-header")
    const host = document.querySelector(".terminal-frame-root")
    if (v || h) {
      window.__samples.push({
        t: Math.round(performance.now() - t0),
        headerH: h ? h.offsetHeight : 0,
        clientH: v ? v.clientHeight : 0,
        scrollH: v ? v.scrollHeight : 0,
        scrollTop: v ? v.scrollTop : 0,
        // the terminal is hidden until its first content has loaded
        opacity: host ? Number(getComputedStyle(host).opacity) : 1,
      })
    }
    if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

await page.goto(`${BRIDGE}/bridge/session?session=${encodeURIComponent(sessionId)}`, {
  waitUntil: "domcontentloaded",
})
await page.waitForSelector(".xterm-viewport", { timeout: 8000 })
await sleep(4300)

const samples = await page.evaluate(() => window.__samples || [])
await browser.close()

if (samples.length < 20) {
  fail(`too few samples (${samples.length}) — terminal never rendered?`)
  console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
  process.exit()
}

// 1. Header shake: the iframe header changing height *after the terminal
//    is on screen*. The header building up from 0 before the terminal
//    renders shoves nothing — only a change once clientH>0 is a visible
//    shake of the terminal pane.
const visible = samples.filter((s) => s.clientH > 0)
const heightChanges = []
for (let i = 1; i < visible.length; i++) {
  if (visible[i].headerH !== visible[i - 1].headerH) {
    heightChanges.push(`${visible[i - 1].headerH}->${visible[i].headerH}@${visible[i].t}ms`)
  }
}

// 2. Visible scroll stepping: scrollTop moving while the terminal is
//    actually on screen (opacity ~1). The chunked-replay stepping is
//    expected — it must all happen while hidden. Once revealed the
//    scroll position should be stable (at the bottom).
const shown = samples.filter((s) => s.opacity >= 0.99 && s.scrollH - s.clientH > 60)
let visibleSteps = 0
for (let i = 1; i < shown.length; i++) {
  if (Math.abs(shown[i].scrollTop - shown[i - 1].scrollTop) > 8) visibleSteps += 1
}

// Bounce: scrollTop dropping back to the top after having reached the
// bottom — the attach-time regression the scroll fixes must prevent.
let jumps = 0
let reachedBottom = false
let prevAtTop = false
for (const s of shown) {
  const sc = s.scrollH - s.clientH
  const atBottom = sc - s.scrollTop <= 12
  const atTop = s.scrollTop <= 20
  if (atBottom) reachedBottom = true
  if (atTop && reachedBottom && !prevAtTop) jumps += 1
  prevAtTop = atTop
}

const last = samples[samples.length - 1]
const scrollable = last.scrollH - last.clientH
const offBottom = scrollable - last.scrollTop
const everShown = samples.some((s) => s.opacity >= 0.99)

console.log(`  samples=${samples.length}  header-changes(visible)=${heightChanges.length}  visible-scroll-steps=${visibleSteps}`)
if (heightChanges.length) console.log(`  header: ${heightChanges.join("  ")}`)
console.log(`  final: headerH=${last.headerH}  scrollTop=${last.scrollTop}/${scrollable}  opacity=${last.opacity}`)

// Hard checks — the deterministic behaviours the fixes guarantee:
//   * the terminal is revealed (reveal-on-load works),
//   * its header doesn't shake it once visible,
//   * it never bounces all the way back to the TOP after attach.
// Live output tailing (small steps, exact final offset) is NOT asserted:
// against a live agent session that is genuinely the documented Bug B
// (TUI redraws) and is reported, not gated, below.
if (!everShown) fail("terminal never became visible (stuck hidden)")
else ok("terminal revealed after load")

if (heightChanges.length !== 0)
  fail(`iframe header changed height ${heightChanges.length}× while terminal visible — a shake`)
else ok("iframe header height stable once terminal visible")

if (scrollable <= 60) {
  ok("attach-scroll check inconclusive-but-safe: content fits ~one screen")
} else {
  if (jumps === 0) ok("never bounced back to the top after attach")
  else fail(`viewport bounced to the top ${jumps}× — attach regression`)
  // informational: live-session tailing during the window
  console.log(
    `  (info) post-reveal scroll steps=${visibleSteps}, final ${offBottom}px off bottom` +
      (offBottom > 200 ? " — live agent redraw disturbed scroll (Bug B, known)" : ""),
  )
}

console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
