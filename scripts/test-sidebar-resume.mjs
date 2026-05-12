// E2E test: PTY session survives rebuild + refresh.
//
// Flow:
//   1. open staging / in headless browser
//   2. wait for sidebar to hydrate (status = "connected")
//   3. trigger createBridgeSession by clicking [data-ai-start-pty] (or
//      programmatically since UI button selector may vary)
//   4. assert localStorage has quartz-pty:session:* and terminal iframe
//      is mounted
//   5. trigger a rebuild by touching a content file in staging
//   6. wait for postscript reload, then reload() the page
//   7. assert the same session id is in dataset.sessionId AND the
//      terminal iframe is back without us clicking anything

import { chromium } from "playwright"
import { execSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

// Defaults target the staging stack. Override via env for any other:
//   BASE=http://127.0.0.1:8080 BRIDGE=http://127.0.0.1:3000 \
//     TOUCH_FILE=/abs/path/content/file.md node scripts/test-sidebar-resume.mjs
const BASE = process.env.BASE || "http://127.0.0.1:8081"
const BRIDGE = process.env.BRIDGE || "http://127.0.0.1:3001"
const TOUCH_FILE =
  process.env.TOUCH_FILE || "/Users/haonanchang/Projects/quartz_pty_staging/content/demos/index.md"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

const fail = (msg) => {
  console.error("❌", msg)
  process.exit(1)
}
const ok = (msg) => console.log("✓", msg)

// step 1+2: load page, wait for hydration
console.log("step 1: load staging /")
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
await page.waitForSelector(".ai-sidebar", { timeout: 5000 })
ok("sidebar element rendered")

// hydrateBridgeSidebars is async; wait for status to become "connected"
// (or for the badge to settle). Inspect data-bridge-origin first.
const bridgeOrigin = await page.locator(".ai-sidebar").getAttribute("data-bridge-origin")
console.log(`  data-bridge-origin = ${bridgeOrigin}`)
if (bridgeOrigin !== BRIDGE) fail(`expected ${BRIDGE}, got ${bridgeOrigin}`)
ok("bridge origin baked into HTML")

// give hydrate a moment
await sleep(2000)

// Sidebar AI is a site-level document operator. Page ids are injected as
// context, but the persisted PTY identity stays on the global workspace.
const WORKSPACE = "quartz-site"

console.log("step 2: create a PTY session via bridge API")
const sess = await page.evaluate(
  async ([bridge, ws]) => {
    const res = await fetch(`${bridge}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
      body: JSON.stringify({
        agent: "codex",
        model: "gpt-5.4-mini",
        difficulty: "medium",
        workspaceId: ws,
      }),
    })
    const body = await res.json()
    return body.session?.sessionId || body.session?.id
  },
  [BRIDGE, WORKSPACE],
)
if (!sess) fail("session creation returned no id")
ok(`session created: ${sess}`)

const storageKey = `quartz-pty:session:${BRIDGE}:${WORKSPACE}`
await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [storageKey, sess])
ok(`localStorage[${storageKey}] = ${sess}`)

// step 5: trigger a rebuild
console.log("step 3: trigger rebuild by touching content")
execSync(`touch ${TOUCH_FILE}`)

// give quartz a moment to rebuild
await sleep(3000)

// step 6: hard reload
console.log("step 4: reload the page")
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForSelector(".ai-sidebar", { timeout: 5000 })

// give hydrate a moment to fetch state + mount
await sleep(2500)

// step 7: assert the sidebar re-mounted the terminal
const dataset = await page.evaluate(() => {
  const el = document.querySelector(".ai-sidebar")
  return { sessionId: el?.dataset.sessionId, workspaceId: el?.dataset.workspaceId }
})
console.log(
  `  after reload: dataset.sessionId=${dataset.sessionId} workspaceId=${dataset.workspaceId}`,
)

if (!dataset.sessionId) {
  fail("dataset.sessionId is empty after reload — resume did NOT happen")
}
if (dataset.sessionId !== sess) {
  fail(`dataset.sessionId=${dataset.sessionId} ≠ saved ${sess} — wrong session restored`)
}
ok(`dataset.sessionId restored to ${sess}`)

const iframeSrc = await page.evaluate(() => {
  const f = document.querySelector(".ai-sidebar iframe")
  return f?.src
})
if (!iframeSrc || !iframeSrc.includes(`session=${encodeURIComponent(sess)}`)) {
  fail(`terminal iframe not mounted with session=${sess}. src=${iframeSrc}`)
}
ok(`terminal iframe mounted: ${iframeSrc}`)

// step 8: localStorage still set
const finalStored = await page.evaluate((k) => window.localStorage.getItem(k), storageKey)
if (finalStored !== sess) fail(`localStorage diverged: ${finalStored}`)
ok(`localStorage still ${sess}`)

console.log("\n✅ PTY session resumed across rebuild + refresh")

await browser.close()
