// Quick layout sanity check for the AI sidebar after the terminal-pane
// height change: the sidebar must not overflow, and the terminal frame
// should have gained vertical room.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8081"
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" })
await page.waitForSelector(".ai-sidebar", { timeout: 8000 })
await sleep(1500)

const m = await page.evaluate(() => {
  const sb = document.querySelector(".ai-sidebar")
  const tf = document.querySelector(".ai-sidebar__terminal-frame")
  const ta = document.querySelector(".ai-sidebar__textarea")
  return {
    sidebarH: sb?.clientHeight,
    sidebarScrollH: sb?.scrollHeight,
    termFrameH: tf?.clientHeight,
    textareaH: ta?.clientHeight,
  }
})
console.log(JSON.stringify(m, null, 1))
console.log(m.sidebarScrollH > m.sidebarH + 2 ? "X sidebar OVERFLOWS its container" : "✓ sidebar fits — no overflow")
console.log(`terminal frame: ${m.termFrameH}px   composer textarea: ${m.textareaH}px`)
await browser.close()
