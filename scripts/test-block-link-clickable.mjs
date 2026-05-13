// Regression: an <a> inside a draggable .block-card must remain
// clickable. Before fix: dragstart on the parent card hijacked the
// anchor click in Chromium (link-drag instead of nav). After fix:
// dragstart in block-toolbar.inline.ts calls event.preventDefault()
// when the target is interactive, so click → spaNavigate fires.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = "http://127.0.0.1:8090"
const fail = (m) => { console.error("✗", m); process.exit(1) }
const ok = (m) => console.log("✓", m)
const note = (m) => console.log("·", m)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()
page.on("console", (msg) => { if (msg.type() === "error") note(`[browser error] ${msg.text()}`) })

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
await page.waitForSelector("article .block-card[data-block-id]", { timeout: 8000 })
await sleep(500)  // block-toolbar bind cycle

// Locate the first anchor that lives inside a .block-card (excluding
// heading autolink # icons, which are typed differently).
const targetHref = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll("article .block-card[data-block-id]"))
  for (const card of cards) {
    const anchors = Array.from(card.querySelectorAll("a[href]"))
    for (const a of anchors) {
      const href = a.getAttribute("href") || ""
      if (!href || href.startsWith("#")) continue
      if (a.classList.contains("anchor")) continue  // heading autolink
      return { href, text: (a.textContent || "").trim() }
    }
  }
  return null
})
if (!targetHref) fail("no anchor found inside any block-card on the homepage")
note(`target link: "${targetHref.text}" → ${targetHref.href}`)

// Click the link by simulated mouse (Playwright .click triggers the
// real pointer flow, which is what the bug was about — programmatic
// .click() on the element bypasses dragstart and would mask the bug).
const linkLocator = page.locator(`article .block-card[data-block-id] a[href="${targetHref.href}"]`).first()
const startedAt = page.url()
await linkLocator.click()
await sleep(800)
const landedAt = page.url()

if (landedAt === startedAt) fail(`link click did NOT navigate — still at ${landedAt} (bug present)`)
ok(`link click navigated: ${startedAt} → ${landedAt}`)

await browser.close()
console.log("\n✅ Anchor inside block-card stays clickable (drag-hijack regression test).")
