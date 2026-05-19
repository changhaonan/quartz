// e2e: the global 中/EN language toggle must flip <html data-lang>,
// localStorage, the visible button label, and broadcast langchange.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8080"
const fail = (m) => { console.error("X", m); process.exitCode = 1 }
const ok = (m) => console.log("✓", m)

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
await sleep(1500) // let nav fire + handlers attach

const toggles = await page.locator(".langtoggle").count()
console.log(`  .langtoggle buttons found: ${toggles}`)
if (!toggles) {
  fail("no .langtoggle button in the page")
  await browser.close()
  process.exit()
}

const state = async () =>
  page.evaluate(() => {
    const visible = [...document.querySelectorAll(".langtoggle")].map((b) => {
      const zh = b.querySelector(".lang-zh")
      const en = b.querySelector(".lang-en")
      const vis = (el) => el && getComputedStyle(el).display !== "none"
      return vis(zh) ? "中" : vis(en) ? "EN" : "(none)"
    })
    return {
      dataLang: document.documentElement.getAttribute("data-lang"),
      storage: localStorage.getItem("lang"),
      visibleLabels: visible,
    }
  })

const before = await state()
console.log("  before click:", JSON.stringify(before))

// listen for langchange
await page.evaluate(() => {
  window.__lc = []
  document.addEventListener("langchange", (e) => window.__lc.push(e.detail?.lang))
})

await page.locator(".langtoggle").first().click()
await sleep(400)
const after = await state()
const events = await page.evaluate(() => window.__lc)
console.log("  after click: ", JSON.stringify(after), "langchange events:", JSON.stringify(events))

if (before.dataLang === after.dataLang) fail(`data-lang did not change (still ${after.dataLang})`)
else ok(`data-lang flipped ${before.dataLang} -> ${after.dataLang}`)

if (after.storage !== after.dataLang) fail(`localStorage[lang]=${after.storage} != data-lang=${after.dataLang}`)
else ok("localStorage updated")

if (!events.length) fail("no langchange event broadcast")
else ok(`langchange broadcast (${events.join(",")})`)

if (before.visibleLabels.join() === after.visibleLabels.join())
  fail(`button label did not flip (still ${after.visibleLabels.join("/")})`)
else ok(`button label flipped ${before.visibleLabels.join("/")} -> ${after.visibleLabels.join("/")}`)

await browser.close()
console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
