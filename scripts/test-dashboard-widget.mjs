// e2e: /dashboard widget — mount, sections render, finance numbers from the
// latest content/.finance report, and interactive goal-checkbox persistence.
//
// Expects a quartz server already serving the target content tree. BASE
// defaults to staging (:8081); override for dev/prod. CONTENT_ROOT must point
// at the content tree that BASE serves so the persistence check reads the
// right data.json (staging worktree by default).
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = process.env.BASE ?? "http://127.0.0.1:8081"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT_ROOT = process.env.CONTENT_ROOT ?? path.join(ROOT, "content")
const DATA_FILE = path.join(CONTENT_ROOT, "dashboard.runtime/data.json")

const fail = (m) => {
  console.error("X", m)
  process.exit(1)
}
const ok = (m) => console.log("✓", m)

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
page.on("pageerror", (e) => console.warn("  [pageerror]", e.message))

try {
  // --- 1. Widget mounts -----------------------------------------------------
  await page.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".quartz-widget[data-widget-type='dashboard']", { timeout: 5000 })
  await page.waitForSelector(".dashboard", { timeout: 8000 })
  const state = await page.getAttribute(".quartz-widget", "data-widget-state")
  if (state !== "ready") fail(`widget state is "${state}", expected "ready"`)
  ok("dashboard widget mounted (state=ready)")

  // Aggregate fetch is async — give it a moment to populate sections.
  await sleep(1500)

  // --- 2. All six sections render ------------------------------------------
  const headings = await page.$$eval(".dash-section h2", (els) =>
    els.map((e) => e.textContent.trim()),
  )
  // Default locale is zh-CN — headings are the Chinese i18n strings.
  for (const want of ["目标", "财务", "自定义指标", "工作流", "想法", "Bridge"]) {
    if (!headings.some((h) => h.includes(want))) {
      fail(`section "${want}" missing — got: ${headings.join(", ")}`)
    }
  }
  ok(`all sections render: ${headings.join(" · ")}`)

  // --- 3. Finance numbers from the latest .finance report ------------------
  // Pick the section by its heading, not position — section order shifts as
  // the dashboard grows.
  const financeText = await page.evaluate(() => {
    const sec = [...document.querySelectorAll(".dash-section")].find(
      (s) => s.querySelector("h2")?.textContent.trim() === "财务",
    )
    return sec?.textContent ?? ""
  })
  if (!/\$[\d,]+\.\d{2}/.test(financeText)) {
    fail(`finance section shows no currency-formatted numbers: ${financeText.slice(0, 200)}`)
  }
  // 05_16.json cash+deposits total is 339410.13 — assert it surfaced.
  if (!financeText.includes("339,410.13")) {
    fail(`finance section missing expected cash total 339,410.13`)
  }
  ok("finance section renders numbers from content/.finance report")

  // --- 4. Workflow cards present (aggregate emitter worked) ----------------
  const wfCards = await page.$$eval(".dash-card", (els) => els.length)
  if (wfCards < 1) fail("no workflow cards rendered")
  ok(`workflow section shows ${wfCards} cards`)

  // --- 5. Interactive write: set a goal's status, assert persistence -------
  // Track the card by its data-goal-id — board column order means the first
  // DOM card is not necessarily goals[0] in the file.
  const before = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
  if (before.goals.length === 0) fail("no goals in data.json to edit")

  const card = page.locator(".dash-gcard").first()
  const goalId = await card.getAttribute("data-goal-id")
  if (!goalId) fail("first goal card has no data-goal-id")
  const statusBefore = before.goals.find((g) => g.id === goalId)?.status
  const target = statusBefore === "done" ? "todo" : "done"
  await card.locator(`.dash-seg__btn[data-status="${target}"]`).click()
  // write() is debounced/awaited inside the renderer; poll the file.
  let persisted = false
  for (let i = 0; i < 25; i++) {
    await sleep(200)
    const now = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    if (now.goals.find((g) => g.id === goalId)?.status === target) {
      persisted = true
      break
    }
  }
  if (!persisted) fail("goal status change did NOT persist to data.json")
  ok("goal status segmented control persisted to dashboard.runtime/data.json")

  // Restore original state so the test is idempotent.
  fs.writeFileSync(DATA_FILE, JSON.stringify(before, null, 2) + "\n")
  ok("restored data.json to original state")

  console.log("\nALL DASHBOARD E2E CHECKS PASSED")
} catch (e) {
  fail(e.message)
} finally {
  await browser.close()
}
