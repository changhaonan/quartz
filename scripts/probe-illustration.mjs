import { chromium } from "playwright"

const url = process.argv[2] || "http://localhost:8080/boards/illustration-board"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

const consoleEvents = []
page.on("console", (msg) => {
  consoleEvents.push({ type: msg.type(), text: msg.text() })
})
page.on("pageerror", (err) => {
  consoleEvents.push({ type: "pageerror", text: `${err.name}: ${err.message}\n${err.stack ?? ""}` })
})
page.on("requestfailed", (req) => {
  consoleEvents.push({ type: "reqfail", text: `${req.method()} ${req.url()} :: ${req.failure()?.errorText}` })
})

console.log(`navigating to ${url}`)
await page.goto(url, { waitUntil: "networkidle", timeout: 30000 })
await page.waitForTimeout(1500)

const widgetState = await page.evaluate(() => {
  const el = document.querySelector(".quartz-widget")
  if (!el) return { found: false }
  const rect = el.getBoundingClientRect()
  return {
    found: true,
    state: el.getAttribute("data-widget-state"),
    type: el.getAttribute("data-widget-type"),
    src: el.getAttribute("data-widget-src"),
    path: el.getAttribute("data-widget-path"),
    workspaceId: el.getAttribute("data-workspace-id"),
    mode: el.getAttribute("data-widget-mode"),
    rect: { width: rect.width, height: rect.height },
    innerHTML: el.innerHTML.slice(0, 800),
    childCount: el.children.length,
  }
})

const flowState = await page.evaluate(() => {
  const flow = document.querySelector(".react-flow")
  if (!flow) return { found: false }
  const rect = flow.getBoundingClientRect()
  const viewport = flow.querySelector(".react-flow__viewport")
  const nodes = flow.querySelectorAll(".react-flow__node")
  const edges = flow.querySelectorAll(".react-flow__edge")
  return {
    found: true,
    rect: { width: rect.width, height: rect.height },
    nodeCount: nodes.length,
    edgeCount: edges.length,
    viewportTransform: viewport ? viewport.getAttribute("style") : null,
  }
})

console.log("\n=== widget state ===")
console.log(JSON.stringify(widgetState, null, 2))
console.log("\n=== react-flow state ===")
console.log(JSON.stringify(flowState, null, 2))
console.log("\n=== console events ===")
for (const e of consoleEvents) {
  console.log(`[${e.type}] ${e.text}`)
}

await page.screenshot({ path: "/tmp/illustration-screenshot.png", fullPage: true })
console.log("\nscreenshot saved to /tmp/illustration-screenshot.png")

await browser.close()
