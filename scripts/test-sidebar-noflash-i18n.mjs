// e2e: the AI sidebar must not flash English chrome before swapping to
// zh-CN. With localStorage["lang"] unset (site default zh-CN), the inline
// no-flash script in AiSidebar.tsx swaps the [data-i18n*] strings during
// HTML parse — before first paint — so the sidebar is already Chinese the
// instant it is visible. This test catches a regression to the old
// afterDOMLoaded-only swap, which painted English first.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8087"
const fail = (m) => {
  console.error("X", m)
  process.exitCode = 1
}
const ok = (m) => console.log("✓", m)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

// English chrome strings that must NEVER be observed once the sidebar exists.
const EN_ONLY = ["Document operator", "Send", "Summarize", "PTY Session"]

// Catch a flash mid-parse: poll the DOM aggressively from the moment the
// .ai-sidebar element first appears. The inline script runs synchronously
// at parse time, so even the earliest sample must already be Chinese.
let flashed = null
await page.addInitScript(() => {
  // record the very first paint-relevant snapshot of the sidebar
  const grab = () => {
    const t = document.querySelector('.ai-sidebar [data-i18n="headerTitle"]')
    if (t) (window).__firstSidebarText ??= t.textContent
  }
  const obs = new MutationObserver(grab)
  obs.observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener("DOMContentLoaded", grab)
})

await page.goto(BASE + "/", { waitUntil: "commit" })
// poll from the earliest possible moment
const seen = new Set()
for (let i = 0; i < 120; i++) {
  const snap = await page
    .evaluate(() => {
      const el = document.querySelector('.ai-sidebar [data-i18n="headerTitle"]')
      return el ? el.textContent?.trim() ?? null : null
    })
    .catch(() => null)
  if (snap) seen.add(snap)
  await sleep(8)
}
await page.waitForLoadState("domcontentloaded")
await sleep(1500) // let postscript hydrate too

const firstText = await page.evaluate(() => (window).__firstSidebarText ?? null)
const finalText = await page.evaluate(
  () => document.querySelector('.ai-sidebar [data-i18n="headerTitle"]')?.textContent?.trim() ?? null,
)

console.log("  header snapshots seen during load:", [...seen])
console.log("  first observed header text:", JSON.stringify(firstText))
console.log("  final header text:", JSON.stringify(finalText))

if (finalText !== "文档操作员") fail(`expected final header "文档操作员", got ${JSON.stringify(finalText)}`)
else ok("final sidebar header is zh-CN (文档操作员)")

if (seen.has("Document operator")) fail("English header 'Document operator' was observed during load — FLASH")
else ok("English header never observed during load — no flash")

if (firstText && firstText !== "文档操作员")
  fail(`first MutationObserver snapshot was non-Chinese: ${JSON.stringify(firstText)} — FLASH`)
else ok(`first observed snapshot was zh-CN`)

// Sanity: full body text should not carry the English-only sidebar strings.
const bodyText = await page.evaluate(() => document.querySelector(".ai-sidebar")?.textContent ?? "")
for (const s of EN_ONLY) {
  if (bodyText.includes(s)) fail(`sidebar still shows English string "${s}"`)
}
if (!EN_ONLY.some((s) => bodyText.includes(s))) ok("no English-only sidebar strings remain in DOM")

await browser.close()
console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
