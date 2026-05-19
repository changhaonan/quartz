// e2e: the dashboard Health section's manual cards — calorie/meal tracker
// and the weight "today" field. Verifies add → total updates → persists
// across reload → delete persists. Cleans up after itself so the staging
// dashboard data is left unchanged.
import { chromium } from "playwright"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE || "http://127.0.0.1:8081"
const fail = (m) => { console.error("X", m); process.exitCode = 1 }
const ok = (m) => console.log("✓", m)
const FOOD = `e2e-probe-${Date.now()}`

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()

const load = async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".dash-cal", { timeout: 10000 })
  await sleep(1200) // widget hydrate + runtime data fetch
}

await load()
ok("dashboard health cards mounted (.dash-cal present)")

if (!(await page.locator(".dash-hentry__input").count())) fail("weight 'today' input missing")
else ok("weight card has a manual 'today' input")

const calTotal = () =>
  page.evaluate(() => {
    const el = document.querySelector(".dash-cal__total")
    return el ? parseInt(el.textContent.replace(/[^0-9]/g, ""), 10) || 0 : -1
  })
const rowCount = () => page.locator(".dash-cal__row").count()

const total0 = await calTotal()
const rows0 = await rowCount()
console.log(`  before: total=${total0}kcal rows=${rows0}`)

// --- add a meal -----------------------------------------------------------
await page.locator(".dash-cal__add").click()
await sleep(300)
// the new row's food field is focused on mount
await page.keyboard.type(FOOD)
await page.keyboard.press("Enter")
await sleep(200)
// set kcal on that row (find the row carrying our food text)
const probeRow = page.locator(".dash-cal__row", { has: page.locator(`input[value="${FOOD}"]`) })
if (!(await probeRow.count())) {
  fail("added meal row not found after typing food")
} else {
  await probeRow.locator(".dash-cal__kcal").click()
  await page.keyboard.type("333")
  await page.keyboard.press("Enter")
  await sleep(800) // debounced write flush + network

  const total1 = await calTotal()
  if (total1 === total0 + 333) ok(`calorie total updated ${total0} → ${total1} (+333)`)
  else fail(`total did not add up: ${total0} → ${total1} (expected +333)`)
}

// --- persistence across reload -------------------------------------------
await load()
const persisted = await page.locator(`.dash-cal__row input[value="${FOOD}"]`).count()
if (persisted) ok("added meal persisted across reload (write-back works)")
else fail("added meal lost after reload — write-back failed")

const totalAfterReload = await calTotal()
if (totalAfterReload >= 333) ok(`calorie total persisted (${totalAfterReload}kcal)`)
else fail(`calorie total not persisted: ${totalAfterReload}`)

// --- weight field round-trip ---------------------------------------------
const wInput = page.locator(".dash-hentry__input")
const w0 = await wInput.inputValue()
await wInput.click()
await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
await page.keyboard.type("71.4")
await page.keyboard.press("Enter")
await sleep(800)
await load()
const wPersisted = await page.locator(".dash-hentry__input").inputValue()
if (wPersisted === "71.4") ok("weight 'today' value persisted across reload")
else fail(`weight not persisted: got "${wPersisted}"`)
// restore prior weight value (clear if it was empty)
const wRestore = page.locator(".dash-hentry__input")
await wRestore.click()
await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
if (w0) await page.keyboard.type(w0)
else await page.keyboard.press("Delete")
await page.keyboard.press("Enter")
await sleep(800)

// --- clean up: delete the probe meal -------------------------------------
await load()
const delRow = page.locator(".dash-cal__row", { has: page.locator(`input[value="${FOOD}"]`) })
if (await delRow.count()) {
  await delRow.locator(".dash-cal__x").click()
  await sleep(800)
  await load()
  const stillThere = await page.locator(`.dash-cal__row input[value="${FOOD}"]`).count()
  if (!stillThere) ok("probe meal deleted — staging data left clean")
  else fail("probe meal still present after delete")
}

await browser.close()
console.log(process.exitCode ? "\nFAILED" : "\nPASSED")
